//! The program's ladder against `@skech/core`'s, row for row (`vectors/ladder.ts` prints them). The Monad contracts
//! are checked against the same file (`evm/test/LadderVectors.t.sol`).

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rows {
    chance: Vec<u32>,
    difficulty: Vec<u8>,
    with_it: Vec<bool>,
    momentum: Vec<i64>,
    rung: Vec<u16>,
}

#[test]
fn the_ladder_is_the_same_integers_as_the_app_and_monad() {
    let rows: Rows = serde_json::from_str(include_str!("../vectors/ladder.json")).unwrap();
    let n = rows.rung.len();
    assert!(n > 10_000);
    assert!(rows.chance.len() == n && rows.difficulty.len() == n && rows.with_it.len() == n && rows.momentum.len() == n);
    for i in 0..n {
        let (chance, d, with_it, momentum) = (rows.chance[i], rows.difficulty[i], rows.with_it[i], rows.momentum[i]);
        assert_eq!(skech::ladder::rung_for(chance, d, with_it, momentum), rows.rung[i], "chance {chance}, difficulty {d}, with it {with_it}, momentum {momentum}");
    }
}
