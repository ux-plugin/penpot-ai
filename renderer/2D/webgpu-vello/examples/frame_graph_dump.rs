//! The graph gate: the frame graph of every battery scene, and of the editor showcase at rest and
//! crossing the left edge, as text fixtures under `fixtures/graphs/` — and under
//! `fixtures/expanded/` the graph the scheduler plans, DAG++, with every read past the frame
//! rerouted through a halo (or a line saying nothing escapes). No GPU.
//!
//! `--check` (the gate) fails when a scene's graph or its expansion differs from its fixture, or
//! when the showcase graph changes structure between the two views — the graph does not know
//! about edges; its expansion does. `--write` regenerates the fixtures. `SCENE=<name>` alone
//! prints one scene's graph and expansion.
//!
//! Run: `cargo run --release --example frame_graph_dump -- --check`.

use render_core::kurbo::Affine;
use render_core::vello::frame_graph::FrameGraph;
use render_core::vello::graph_build::{build_frame_graph, dump};
use render_core::vello::scheduler::expanded;

#[path = "util/replay.rs"]
mod replay_util;
#[path = "util/scenes.rs"]
mod scenes;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/graphs");
const EXPANDED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/expanded");
/// The store the expansion is decided against: the device cap and preset pages the shape gate uses.
const STORE: (u32, f64) = (16384, 4.0);

/// DAG++ as text: the expansion's dump, or one line when no read escapes the frame.
fn expansion(g: &FrameGraph) -> String {
    match expanded(g, g.frame.width() as u32, g.frame.height() as u32, STORE.0, STORE.1) {
        Some(x) => {
            x.validate().unwrap_or_else(|e| panic!("expansion: {e}\n{}", dump(&x)));
            dump(&x)
        }
        None => "no read escapes the frame\n".to_string(),
    }
}
const EDITOR_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/showcase-editor.abi.json");
/// The editor showcase's device size and zoom, as the shape gate renders it.
const EDITOR: (u32, u32, f32) = (2560, 1086, 1.5);

fn battery_graph(scene: &str) -> FrameGraph {
    let cells = scenes::install(scene);
    let (w, h) = render_core::parity::canvas_size(cells as usize);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_view(1.0, 0.0, 0.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    build_frame_graph(Affine::IDENTITY, w, h)
}

fn editor_graph(pan: (f32, f32)) -> FrameGraph {
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    render_core::vello::abi::set_view(EDITOR.2, pan.0, pan.1);
    build_frame_graph(Affine::IDENTITY, EDITOR.0, EDITOR.1)
}

/// The graph with its geometry stripped: what must not change when the view moves.
fn structure(g: &FrameGraph) -> Vec<String> {
    g.nodes.iter().enumerate().map(|(i, n)| format!("{} {:?} {}", g.is_spine(i), n.inputs, n.label)).collect()
}

fn summary(g: &FrameGraph) -> String {
    let spine = (0..g.nodes.len()).filter(|&i| g.is_spine(i)).count();
    let chains = g.nodes.iter().filter(|n| matches!(n.op, render_core::vello::frame_graph::Op::Compose { .. })).count();
    format!("{} nodes, {spine} spine, {chains} chains", g.nodes.len())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let write = args.iter().any(|a| a == "--write");
    let check = args.iter().any(|a| a == "--check");
    if let Ok(scene) = std::env::var("SCENE") {
        let g = battery_graph(&scene);
        g.validate().unwrap_or_else(|e| panic!("{scene}: {e}"));
        print!("{}", dump(&g));
        println!("{scene}: {}", summary(&g));
        println!("expanded:");
        print!("{}", expansion(&g));
        return;
    }
    if !(write || check) {
        println!("usage: frame_graph_dump --check | --write | SCENE=<name>");
        return;
    }
    std::fs::create_dir_all(FIXTURES).expect("fixtures dir");
    std::fs::create_dir_all(EXPANDED).expect("fixtures dir");
    let mut failures = 0u32;
    let mut record = |dir: &str, name: &str, text: &str, summary: &str| {
        let path = format!("{dir}/{name}.txt");
        let shown = format!("{}{name}", if dir == EXPANDED { "expanded/" } else { "" });
        if write {
            std::fs::write(&path, text).expect("write fixture");
            println!("{shown:<32} wrote   {summary}");
            return;
        }
        match std::fs::read_to_string(&path) {
            Ok(have) if have == text => println!("{shown:<32} PASS    {summary}"),
            Ok(have) => {
                failures += 1;
                let first = have.lines().zip(text.lines()).position(|(a, b)| a != b).unwrap_or(have.lines().count().min(text.lines().count()));
                println!("{shown:<32} FAIL    {summary} — first difference at line {first}");
                println!("  fixture: {}", have.lines().nth(first).unwrap_or("<end>"));
                println!("  now:     {}", text.lines().nth(first).unwrap_or("<end>"));
            }
            Err(_) => {
                failures += 1;
                println!("{shown:<32} MISSING {summary}");
            }
        }
    };
    let mut both = |name: &str, g: &FrameGraph| {
        g.validate().unwrap_or_else(|e| panic!("{name}: {e}\n{}", dump(g)));
        record(FIXTURES, name, &dump(g), &summary(g));
        let x = expansion(g);
        let halos = x.lines().filter(|l| l.contains(" Halo of ")).count();
        record(EXPANDED, name, &x, &if halos == 0 { "nothing escapes".to_string() } else { format!("{halos} halo(s), {} nodes", x.lines().count() - 1) });
    };
    for &scene in scenes::BATTERY {
        let g = battery_graph(scene);
        both(scene, &g);
    }
    let rep = replay_util::replay(EDITOR_FIXTURE);
    println!("editor showcase: {} calls replayed", rep.applied);
    let at_rest = editor_graph((0.0, 0.0));
    let crossing = editor_graph((-450.0, -165.0));
    both("showcase-editor", &at_rest);
    both("showcase-editor-crossing", &crossing);
    if structure(&at_rest) == structure(&crossing) {
        println!("{:<24} PASS    the graph is the same crossing the left edge", "showcase-editor-edge");
    } else {
        failures += 1;
        println!("{:<24} FAIL    the graph changed structure when the view moved", "showcase-editor-edge");
    }
    if failures > 0 {
        println!("\n{failures} graph(s) differ from their fixtures");
        std::process::exit(1);
    }
    println!("\nevery graph matches its fixture");
}
