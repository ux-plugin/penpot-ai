//! One line per frame, in the browser console or on stderr: where the frame's time went and what
//! shape the frame had.
//!
//! [`crate::vello::prof`] answers a different question. Its buckets accumulate across frames so a
//! bench can reset, run K frames and divide — which reports a steady state and hides the frame that
//! spiked. A frame that lags only while a glass shape crosses the viewport edge never survives that
//! average, so this reports each frame on its own: the CPU phases in the order the sink runs them,
//! the GPU span the frame actually cost, and the structural counts (regions, leases, rounds,
//! dispatches) that explain why one frame differs from its neighbour.
//!
//! Every number is a delta against the previous frame's snapshot of the same accumulating buckets,
//! so instrumentation lives where it already lived and nothing is timed twice.

use std::cell::{Cell, RefCell};

/// The accumulating buckets this reads, captured at one frame boundary.
#[derive(Clone, Copy, Default)]
struct Snapshot {
    submit: f64,
    present: f64,
    /// Vello's own prepare + encode (`renderer.render`).
    render: f64,
    /// The round loop: every window's bind groups, uniforms and dispatch recording.
    rounds: f64,
    /// Phased begin — the accumulator resolve the first window waits on.
    resolve: f64,
    /// Gather detection, before the DAG is built.
    detect: f64,
    gpu: f64,
    gpu_n: u32,
    submits: u32,
    renders: u32,
    textures: u32,
    pool_hit: u32,
    pool_miss: u32,
    roles: [f64; ROLES.len()],
}

/// The GPU role buckets the sink's [`crate::vello::gputime::PassProfiler`] stamps, in report order.
/// Indices are [`crate::vello::graph::prof_bucket`] values offset by the debug-bucket base.
const ROLES: [(&str, usize); 8] = [
    ("crop", 16),
    ("displace", 17),
    ("refract", 18),
    ("blur", 19),
    ("composite", 20),
    ("stamp", 21),
    ("swap", 22),
    ("other", 23),
];

/// What one frame cost on the CPU, filled in as the sink passes each phase boundary.
#[derive(Clone, Copy, Default)]
pub struct Phases {
    /// Scene walk: the DAG built from the live document.
    pub walk: f64,
    /// `schedule()`: rounds, leases, binding classes.
    pub schedule: f64,
    /// Unit marks baked from the scheduled DAG.
    pub marks: f64,
    /// Region/draft placement into the shelf.
    pub lease: f64,
    /// Scene encoding: every draw the frame records, markers included.
    pub encode: f64,
}

/// What shape the frame had — the counts that separate a cheap frame from an expensive one.
#[derive(Clone, Copy, Default)]
pub struct Shape {
    pub dag_nodes: u32,
    pub rounds: u32,
    pub gathers: u32,
    pub regions: u32,
    pub leases: u32,
    pub marks: u32,
    pub draws: u32,
    pub windows: u32,
}

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    /// Native only: `WV_PERF` is consulted once, on the first frame.
    #[cfg(not(target_arch = "wasm32"))]
    static INIT: Cell<bool> = const { Cell::new(false) };
    static SEQ: Cell<u32> = const { Cell::new(0) };
    static PREV: Cell<Snapshot> = const { Cell::new(Snapshot {
        submit: 0.0, present: 0.0, render: 0.0, rounds: 0.0, resolve: 0.0, detect: 0.0,
        gpu: 0.0, gpu_n: 0, submits: 0, renders: 0,
        textures: 0, pool_hit: 0, pool_miss: 0, roles: [0.0; 8],
    }) };
    static PHASES: Cell<Phases> = const { Cell::new(Phases {
        walk: 0.0, schedule: 0.0, marks: 0.0, lease: 0.0, encode: 0.0,
    }) };
    static SHAPE: Cell<Shape> = const { Cell::new(Shape {
        dag_nodes: 0, rounds: 0, gathers: 0, regions: 0, leases: 0, marks: 0, draws: 0, windows: 0,
    }) };
    /// Frame wall-clock start, so the report can name the part no phase claimed.
    static FRAME_T0: Cell<f64> = const { Cell::new(0.0) };
    /// The last line emitted, for hosts that would rather poll than read a console.
    static LAST: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Turn per-frame logging on or off. Off by default: the report costs a string build per frame.
pub fn set_enabled(on: bool) {
    ON.with(|c| c.set(on));
}

#[must_use]
pub fn enabled() -> bool {
    ON.with(Cell::get)
}

/// The most recent line, or empty before the first frame. Lets a host surface the report in its own
/// UI instead of the console.
#[must_use]
pub fn last_line() -> String {
    LAST.with(|c| c.borrow().clone())
}

/// Open a frame. Cheap enough to call unconditionally.
pub fn begin() {
    #[cfg(not(target_arch = "wasm32"))]
    INIT.with(|c| {
        if !c.get() {
            c.set(true);
            if std::env::var("WV_PERF").is_ok() {
                set_enabled(true);
            }
        }
    });
    FRAME_T0.with(|c| c.set(crate::vello::prof::now()));
    PHASES.with(|c| c.set(Phases::default()));
    SHAPE.with(|c| c.set(Shape::default()));
}

pub fn set_phases(p: Phases) {
    PHASES.with(|c| c.set(p));
}

pub fn set_shape(s: Shape) {
    SHAPE.with(|c| {
        let windows = c.get().windows;
        c.set(Shape { windows, ..s });
    });
}

/// Count one fine window this frame — the unit the round loop dispatches.
pub fn note_window() {
    SHAPE.with(|c| {
        let mut s = c.get();
        s.windows += 1;
        c.set(s);
    });
}

fn snapshot() -> Snapshot {
    use crate::vello::prof::read;
    let mut roles = [0.0; ROLES.len()];
    for (i, (_, b)) in ROLES.iter().enumerate() {
        roles[i] = read(100 + *b as u32);
    }
    Snapshot {
        submit: read(3),
        present: read(17),
        render: read(2),
        rounds: read(127),
        resolve: read(131),
        detect: read(126),
        gpu: read(18),
        gpu_n: read(19) as u32,
        submits: read(13) as u32,
        renders: read(7) as u32,
        textures: read(6) as u32,
        pool_hit: read(8) as u32,
        pool_miss: read(9) as u32,
        roles,
    }
}

/// Close the frame and emit its line. The GPU span belongs to a frame one to three back (readback
/// is async), which is why it is reported as `gpu~` rather than pinned to this frame's number.
pub fn end() {
    if !ON.with(Cell::get) {
        return;
    }
    let now = crate::vello::prof::now();
    let total = now - FRAME_T0.with(Cell::get);
    let cur = snapshot();
    let prev = PREV.with(Cell::get);
    PREV.with(|c| c.set(cur));
    let seq = SEQ.with(|c| {
        let n = c.get();
        c.set(n + 1);
        n
    });

    let p = PHASES.with(Cell::get);
    let s = SHAPE.with(Cell::get);
    let plan = p.walk + p.schedule + p.marks + p.lease;
    let submit = cur.submit - prev.submit;
    let present = cur.present - prev.present;
    let render = cur.render - prev.render;
    let rounds = cur.rounds - prev.rounds;
    let resolve = cur.resolve - prev.resolve;
    let detect = cur.detect - prev.detect;
    let rest =
        (total - detect - plan - p.encode - render - rounds - resolve - submit - present).max(0.0);
    let gpu_frames = cur.gpu_n.saturating_sub(prev.gpu_n);
    let gpu = if gpu_frames == 0 { f64::NAN } else { (cur.gpu - prev.gpu) / f64::from(gpu_frames) };

    let mut line = format!(
        "WV_FRAME {seq} total={total:.2}ms | detect={detect:.2} walk={:.2} sched={:.2} marks={:.2} lease={:.2} encode={:.2} render={render:.2} resolve={resolve:.2} rounds={rounds:.2} submit={submit:.2} present={present:.2} rest={rest:.2}",
        p.walk, p.schedule, p.marks, p.lease, p.encode,
    );
    if gpu.is_finite() {
        line.push_str(&format!(" | gpu~{gpu:.2}ms"));
        let roles: Vec<String> = ROLES
            .iter()
            .enumerate()
            .filter_map(|(i, (name, _))| {
                let ms = cur.roles[i] - prev.roles[i];
                (ms > 0.005).then(|| format!("{name}={ms:.2}"))
            })
            .collect();
        if !roles.is_empty() {
            line.push_str(&format!(" [{}]", roles.join(" ")));
        }
    }
    line.push_str(&format!(
        " | nodes={} rounds={} gathers={} regions={} leases={} marks={} draws={} windows={} dispatch={} submits={} tex={} pool={}/{}",
        s.dag_nodes,
        s.rounds,
        s.gathers,
        s.regions,
        s.leases,
        s.marks,
        s.draws,
        s.windows,
        cur.renders - prev.renders,
        cur.submits - prev.submits,
        cur.textures - prev.textures,
        cur.pool_hit - prev.pool_hit,
        cur.pool_miss - prev.pool_miss,
    ));

    emit(&line);
    LAST.with(|c| *c.borrow_mut() = line);
}

fn emit(line: &str) {
    #[cfg(target_arch = "wasm32")]
    web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(line));
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{line}");
}
