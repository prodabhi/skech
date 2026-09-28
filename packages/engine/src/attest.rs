//! A second opinion on every Coinbase trade before it is signed.
//!
//! Coinbase is the price: it is what the game's chances were measured on, and
//! it is fast. Binance and Kraken attest to it. Each keeps its newest trade
//! here. A price is signed only when two venues agree on it: when a Coinbase
//! trade lands, it is signed as is if an attester is within the band of it.
//! If none is, the attesters' median is signed instead, but only if they are
//! within the band of each other: with two attesters the median is their
//! average, and one venue's bad print must not move what is signed. When no
//! two venues agree, or no attester has been heard from lately, nothing is
//! signed at all.

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// An attester's price older than this no longer counts: it is checked against a Coinbase trade of now.
const FRESH: Duration = Duration::from_secs(2);

#[derive(Clone, Default)]
pub struct Board(Arc<Mutex<BTreeMap<&'static str, (f64, Instant)>>>);

impl Board {
    pub fn set(&self, name: &'static str, price: f64) {
        if price.is_finite() && price > 0.0 {
            self.0.lock().unwrap().insert(name, (price, Instant::now()));
        }
    }

    /// Each attester heard from in the last few seconds, and its newest price.
    pub fn fresh(&self) -> Vec<(&'static str, f64)> {
        self.0.lock().unwrap().iter().filter(|(_, (_, at))| at.elapsed() <= FRESH).map(|(name, (p, _))| (*name, *p)).collect()
    }
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// An attester agrees with Coinbase: sign Coinbase's price.
    Agrees,
    /// They don't, but agree with each other: sign their median instead, to the cent.
    Differs { median: f64 },
    /// Coinbase is outside the band and the attesters don't agree with each other, or only one was heard
    /// from: no two venues agree on a price, so sign nothing.
    Disputed,
    /// No attester to check against: sign nothing.
    Alone,
}

/// `band` is a fraction: 0.0005 is 0.05%.
pub fn decide(coinbase: f64, attesters: &[f64], band: f64) -> Verdict {
    if attesters.is_empty() {
        return Verdict::Alone;
    }
    if attesters.iter().any(|p| ((coinbase - p) / p).abs() <= band) {
        return Verdict::Agrees;
    }
    let mut sorted = attesters.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    let median = if sorted.len() % 2 == 1 { sorted[mid] } else { (sorted[mid - 1] + sorted[mid]) / 2.0 };
    // Every attester within the band of every other: the lowest and the highest are.
    if sorted.len() >= 2 && (sorted[sorted.len() - 1] - sorted[0]) / median <= band {
        Verdict::Differs { median: (median * 100.0).round() / 100.0 }
    } else {
        Verdict::Disputed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BAND: f64 = 0.0005;

    #[test]
    fn within_the_band_coinbase_stands() {
        assert_eq!(decide(83_433.33, &[83_430.00], BAND), Verdict::Agrees);
        assert_eq!(decide(83_433.33, &[83_470.00, 83_401.10], BAND), Verdict::Agrees);
        // One attester is enough: two venues agree, whatever the third printed.
        assert_eq!(decide(83_433.33, &[83_430.00, 90_000.00], BAND), Verdict::Agrees);
    }

    #[test]
    fn outside_it_the_attesters_price_is_signed_if_they_agree() {
        // 0.1% off: a bad print on Coinbase, with Binance and Kraken 0.01% apart.
        assert_eq!(decide(83_516.76, &[83_430.004, 83_438.0], BAND), Verdict::Differs { median: 83_434.0 });
    }

    #[test]
    fn two_attesters_apart_sign_nothing() {
        // Coinbase is off, and so is one of them: their average would be half the bad print.
        assert_eq!(decide(84_300.0, &[83_430.0, 84_500.0], BAND), Verdict::Disputed);
        // Their average is within the band of Coinbase, but neither of them is.
        assert_eq!(decide(83_965.0, &[83_430.0, 84_500.0], BAND), Verdict::Disputed);
        // Coinbase agrees with neither, and they are 0.06% apart.
        assert_eq!(decide(83_600.0, &[83_430.0, 83_480.0], BAND), Verdict::Disputed);
    }

    #[test]
    fn one_attester_cannot_overrule_coinbase() {
        assert_eq!(decide(83_516.76, &[83_430.004], BAND), Verdict::Disputed);
    }

    #[test]
    fn one_bad_attester_is_outvoted() {
        assert_eq!(decide(83_433.33, &[83_430.0, 83_436.0, 70_000.0], BAND), Verdict::Agrees);
    }

    #[test]
    fn no_attester_no_signature() {
        assert_eq!(decide(83_433.33, &[], BAND), Verdict::Alone);
    }

    #[test]
    fn stale_prices_drop_off_the_board() {
        let board = Board::default();
        board.set("binance", 83_430.0);
        board.set("kraken", f64::NAN);
        assert_eq!(board.fresh(), vec![("binance", 83_430.0)]);
        board.0.lock().unwrap().get_mut("binance").unwrap().1 -= FRESH + Duration::from_millis(1);
        assert!(board.fresh().is_empty());
    }
}
