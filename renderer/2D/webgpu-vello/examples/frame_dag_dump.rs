//! Build the whole-frame value-DAG for a fixture and dump it as Mermaid — the raw graph and the
//! topologically-sorted (rounds) schedule. No GPU: this only generates and prints the graph.
//!
//! The Mermaid rendering lives HERE, in the dev harness, not in the library — `frame_dag` owns the
//! model + schedule; visualizing it is a debugging concern.
//!
//! Run: `SCENE=combined cargo run --release --example frame_dag_dump`.

use render_core::vello::frame_dag::{self, Barrier, Category, FrameDag, Node, TILE_PX};

const CLASSDEFS: &str = "  classDef bg fill:#9fe1cb,stroke:#0f6e56,color:#04342c;\n  classDef paint fill:#b5d4f4,stroke:#185fa5,color:#042c53;\n  classDef draft fill:#d3d1c7,stroke:#5f5e5a,color:#2c2c2a;\n  classDef backdrop fill:#fac775,stroke:#854f0b,color:#412402;\n  classDef composite fill:#cecbf6,stroke:#534ab7,color:#26215c;\n";

fn node_decl(i: usize, n: &Node) -> String {
    let label = n.label.replace('"', "'");
    let (open, close, class) = match n.category() {
        Category::Background => ("([\"", "\"])", "bg"),
        Category::Paint => ("[\"", "\"]", "paint"),
        Category::Draft => ("(\"", "\")", "draft"),
        Category::Reload => ("{{\"", "\"}}", "backdrop"),
        Category::Compose => ("[\"", "\"]", "composite"),
    };
    format!("n{i}{open}{label}{close}:::{class}")
}

fn edges(s: &mut String, dag: &FrameDag) {
    for (i, n) in dag.nodes.iter().enumerate() {
        for &j in &n.inputs {
            s.push_str(&format!("  n{j} --> n{i}\n"));
        }
    }
}

/// The raw graph, top-down, one node per op.
fn to_mermaid(dag: &FrameDag) -> String {
    let mut s = String::from("graph TD\n");
    s.push_str(CLASSDEFS);
    for (i, n) in dag.nodes.iter().enumerate() {
        s.push_str(&format!("  {}\n", node_decl(i, n)));
    }
    edges(&mut s, dag);
    s
}

/// The graph after the barrier-aware schedule: nodes grouped into rounds (one `subgraph` per
/// dispatch), left-to-right so rounds read as columns. Each round names the barrier that opened it —
/// a reload or a materialize — so the composite-spine fold is visible against the naive depth.
fn to_mermaid_scheduled(dag: &FrameDag) -> String {
    let sched = dag.schedule(TILE_PX);
    let max = sched.round.iter().copied().max().unwrap_or(0);
    let mut s = String::from("graph LR\n");
    s.push_str(CLASSDEFS);
    for level in 0..=max {
        let count = sched.round.iter().filter(|&&l| l == level).count();
        // Label the round by the barrier that opens it (the first node at this depth that crossed one).
        let why = dag
            .nodes
            .iter()
            .enumerate()
            .find_map(|(i, _)| (sched.round[i] == level).then_some(sched.barrier[i]).flatten())
            .map(|b| match b {
                Barrier::Reload => " ⟂ reload",
                Barrier::Materialize => " ⟂ materialize",
            })
            .unwrap_or("");
        s.push_str(&format!("  subgraph R{level}[\"round {level}{why} · {count} op(s)\"]\n"));
        s.push_str("    direction TB\n");
        for (i, n) in dag.nodes.iter().enumerate() {
            if sched.round[i] == level {
                s.push_str(&format!("    {}\n", node_decl(i, n)));
            }
        }
        s.push_str("  end\n");
    }
    edges(&mut s, dag);
    s
}

fn main() {
    let scene = std::env::var("SCENE").unwrap_or_else(|_| "combined".to_string());
    match scene.as_str() {
        "combined" => render_core::vello::abi::load_combined_scene(),
        "inner-shadow" => render_core::vello::abi::load_inner_shadow_scene(),
        "path-shadow" => render_core::vello::abi::load_path_shadow_scene(),
        "multi-shadow" => render_core::vello::abi::load_multi_shadow_scene(),
        "stack-glass" => render_core::vello::abi::load_stack_glass_scene(2, 0),
        "parity" => render_core::vello::abi::load_parity_scene(),
        "matrix" => render_core::vello::abi::load_matrix_scene(),
        "showcase" => render_core::vello::abi::load_showcase_scene(),
        "stress" => render_core::vello::abi::load_stress_scene_mask(
            std::env::var("STRESS_N").ok().and_then(|v| v.parse().ok()).unwrap_or(2),
            render_core::parity::FX_ALL,
        ),
        _ => render_core::vello::abi::load_combined_scene(),
    };

    let dag = frame_dag::build_frame_dag_installed();
    let naive = dag.levels().iter().copied().max().unwrap_or(0) + 1;
    let rounds = dag.schedule(TILE_PX).rounds();
    let specs = dag.to_stage_specs();
    let atlases = render_core::vello::plan::atlases_needed(&render_core::vello::plan::colour_stages(&specs));
    eprintln!(
        "frame-dag [{scene}]: {} nodes, {rounds} rounds (naive {naive}), {} stages → {atlases} atlases",
        dag.nodes.len(),
        specs.len(),
    );

    println!("%% ===== RAW DAG ({scene}) =====");
    println!("{}", to_mermaid(&dag));
    println!("%% ===== SCHEDULED ({scene}, {rounds} rounds — naive {naive}) =====");
    println!("{}", to_mermaid_scheduled(&dag));
}
