// Empty on purpose. Cargo only sets `OUT_DIR` for a crate that has a build script, and the
// `ToJs` derive in `render-macros` writes its generated JS there — it panics outright if the
// variable is missing. `render-wasm/build.rs` exists for the same reason and says the same
// thing; any crate deriving `ToJs` needs one.
fn main() {}
