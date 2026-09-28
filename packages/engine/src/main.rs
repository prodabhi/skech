//! skech engine: one WebSocket per client app.
//!
//! Down the socket, on connect: who signs and the EIP-712 domain and types
//! they sign under, then the last ten minutes of trades. After that, every
//! BTC-USD trade as it lands, each checked against Binance and Kraken and
//! signed, and Coinbase's heartbeat each second. Upstream it holds a socket to
//! each venue, and fans what it signs out to every client.

mod attest;
mod feeds;
mod quote;

use std::{
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use alloy_primitives::Address;
use alloy_signer_local::PrivateKeySigner;
use axum::{
    Router,
    extract::{
        ConnectInfo, State,
        ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    serve::ListenerExt,
};
use serde_json::json;
use tokio::{
    sync::{Semaphore, broadcast, watch},
    time::timeout,
};

use crate::{attest::Board, feeds::History, quote::Quoter};

/// Updates a client can fall behind by before it is dropped. It reconnects, and the history fills in what it
/// missed: a relayer's bars must not have holes in them.
const BACKLOG: usize = 1024;
/// A client that has not taken a frame in this long is dropped, and its slot freed.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// Nothing a client sends is read but a close, so nothing it sends needs to be big.
const MAX_IN: usize = 4 * 1024;
/// Slots kept for clients on this box (the relayers), so a crowd of players cannot lock them out.
const LOCAL_SLOTS: usize = 32;

#[derive(Clone)]
struct App {
    /// The first message every client gets: who signs, and the EIP-712 domain and types to check against.
    hello: Utf8Bytes,
    history: History,
    /// The history as of the last second, built once and shared by every player's connection.
    recent: watch::Receiver<Utf8Bytes>,
    /// Each update, serialized once, shared by every client.
    feed: broadcast::Sender<Utf8Bytes>,
    /// Connections open at once: from the internet (through Caddy), and from this box.
    public: Arc<Semaphore>,
    local: Arc<Semaphore>,
}

fn main() {
    // The monorepo's one `.env.local`, found by walking up from here. Anything already in the environment wins.
    let _ = dotenvy::from_filename(".env.local");
    // One TLS backend for both the WebSocket and the HTTP client: ring, the only one compiled in.
    let _ = rustls::crypto::ring::default_provider().install_default();
    // A throwaway wallet signs prices no relayer is set to trust, so it is for a laptop only: `bun run dev:engine`
    // passes --dev. Anywhere else a missing key stops the engine here.
    let dev = env::args().skip(1).any(|a| a == "--dev");
    let wallet = match var("ENGINE_PRIVATE_KEY") {
        Some(key) => key.parse::<PrivateKeySigner>().expect("ENGINE_PRIVATE_KEY is not a hex private key"),
        None if dev => {
            eprintln!("ENGINE_PRIVATE_KEY is not set: signing with a throwaway wallet");
            PrivateKeySigner::random()
        }
        None => panic!("ENGINE_PRIVATE_KEY is not set. Only a --dev engine goes on, signing with a throwaway wallet"),
    };
    // One fixed domain, the one prices have always been signed under (quote.rs says why).
    let quoter = Arc::new(Quoter::new(wallet, quote::CHAIN_ID, quote::VERIFYING_CONTRACT));
    eprintln!("signing as {} for chain {}, contract {}", quoter.address(), quote::CHAIN_ID, quote::VERIFYING_CONTRACT);

    // How close two venues must be to agree on a price, in basis points. BTC trades a few bp apart across venues
    // on a normal day; much tighter and Coinbase is overruled, or nothing signed, whenever the market moves.
    let band_bps: f64 = var("ENGINE_BAND_BPS").map(|b| b.parse().expect("ENGINE_BAND_BPS is not a number")).unwrap_or(15.0);
    let band = band_bps / 10_000.0;
    eprintln!("attesting with binance and kraken, band {}%", band * 100.0);
    // This box only, by default: Caddy is the way in. ENGINE_HOST=0.0.0.0 to reach a laptop's engine from a phone.
    let host: IpAddr = var("ENGINE_HOST").map(|h| h.parse().expect("ENGINE_HOST is not an IP address")).unwrap_or(Ipv4Addr::LOCALHOST.into());
    let port = var("ENGINE_PORT").and_then(|p| p.parse().ok()).unwrap_or(3102);
    // Players connected at once. Each holds a socket and a history's worth of buffer.
    let max_clients = var("ENGINE_MAX_CLIENTS").map(|n| n.parse().expect("ENGINE_MAX_CLIENTS is not a number")).unwrap_or(500);

    // Up once the config is read: a bad one panics on every restart, into the journal, not the Sentry plan.
    // Before the runtime, so each worker thread starts with the client bound.
    let _sentry = sentry_init(quoter.address());
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(serve(quoter, band, SocketAddr::new(host, port), max_clients));
}

async fn serve(quoter: Arc<Quoter>, band: f64, addr: SocketAddr, max_clients: usize) {
    let (feed, _) = broadcast::channel(BACKLOG);
    let history = History::default();
    let (recent_tx, recent) = watch::channel(history.frame());
    tokio::spawn({
        let history = history.clone();
        async move {
            let mut every = tokio::time::interval(Duration::from_secs(1));
            loop {
                every.tick().await;
                recent_tx.send_replace(history.frame());
            }
        }
    });
    let app = App {
        hello: json!({
            "type": "hello", "signer": quoter.address().to_checksum(None), "typedData": quoter.typed_data(),
            "attest": { "by": ["binance", "kraken"], "band": band },
        })
            .to_string()
            .into(),
        history: history.clone(),
        recent,
        feed: feed.clone(),
        public: Arc::new(Semaphore::new(max_clients)),
        local: Arc::new(Semaphore::new(LOCAL_SLOTS)),
    };
    let board = Board::default();
    tokio::spawn(feeds::binance(board.clone()));
    tokio::spawn(feeds::kraken(board.clone()));
    tokio::spawn(feeds::coinbase(feed, quoter, history, board, band));

    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(upgrade))
        .with_state(app);

    let port = addr.port();
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("can't listen on {addr}: {e}. Is another engine running? `lsof -iTCP:{port} -sTCP:LISTEN` says who has it.");
            std::process::exit(1);
        }
    }
    // Small frames go out now, not batched up by Nagle.
    .tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    eprintln!("listening on ws://{addr}/ws, up to {max_clients} players and {LOCAL_SLOTS} local clients");
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.expect("server stopped");
}

/// Sentry, for what takes the engine down: a panic is sent, stack and all, before `panic = "abort"` ends the
/// process. Off unless ENGINE_SENTRY_DSN is set, and off on a laptop (no SENTRY_ENVIRONMENT; the box's unit sets
/// production) unless ENGINE_SENTRY_DEV=1, so `bun run dev:engine` never spends the plan.
fn sentry_init(signer: Address) -> Option<sentry::ClientInitGuard> {
    let dsn = var("ENGINE_SENTRY_DSN")?;
    let environment = var("SENTRY_ENVIRONMENT").unwrap_or_else(|| "development".into());
    if environment == "development" && var("ENGINE_SENTRY_DEV").is_none() {
        return None;
    }
    let mut options = sentry::ClientOptions::default();
    // The commit infra/deploy.sh built, else engine@<version>.
    options.release = option_env!("SKECH_RELEASE").map(Into::into).or_else(|| sentry::release_name!());
    options.environment = Some(environment.into());
    let guard = sentry::init((dsn, options));
    sentry::configure_scope(|scope| scope.set_tag("signer", signer));
    Some(guard)
}

/// A variable that is set to something: `KEY=` left blank in `.env.local` counts as unset.
fn var(name: &str) -> Option<String> {
    env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

async fn upgrade(ws: WebSocketUpgrade, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, State(app): State<App>) -> Response {
    // Caddy sets X-Forwarded-For on everything it passes on, so a loopback peer without one is on this box: a relayer.
    let local = peer.ip().is_loopback() && !headers.contains_key("x-forwarded-for");
    let slots = if local { &app.local } else { &app.public };
    let Ok(slot) = slots.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "full, try again soon").into_response();
    };
    ws.max_message_size(MAX_IN).max_frame_size(MAX_IN).read_buffer_size(MAX_IN).on_upgrade(move |socket| async move {
        client(socket, app, local).await;
        drop(slot);
    })
}

/// Push-only: the engine signs what it saw, never what a client asks it to.
async fn client(mut socket: WebSocket, app: App, local: bool) {
    // Subscribed before the history is read; a trade in both is dropped by id. A relayer settles on its bars, so it
    // is sent the history as of now, and misses nothing. A player is sent the one built this second, shared: the
    // trades of the moment before it connected may be in neither, and its chart carries the price flat through them.
    let mut feed = app.feed.subscribe();
    let history = if local { app.history.frame() } else { app.recent.borrow().clone() };
    for frame in [app.hello.clone(), history] {
        if !send(&mut socket, frame).await {
            return;
        }
    }
    loop {
        tokio::select! {
            update = feed.recv() => match update {
                Ok(text) => if !send(&mut socket, text).await { return },
                // Too slow to keep up, or the feed is gone: dropped. It reconnects and is sent what it missed.
                Err(_) => return,
            },
            // Read only to notice the client going away; pings are answered by axum.
            msg = socket.recv() => if matches!(msg, Some(Ok(Message::Close(_))) | Some(Err(_)) | None) { return },
        }
    }
}

/// One frame to a client, or false if it is gone or has not taken it in `SEND_TIMEOUT`.
async fn send(socket: &mut WebSocket, text: Utf8Bytes) -> bool {
    matches!(timeout(SEND_TIMEOUT, socket.send(Message::Text(text))).await, Ok(Ok(())))
}
