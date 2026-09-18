//! Contract 2: the frame plan — every decision made, in the order the GPU runs them.
//!
//! The scheduler produces it; the executor ([`crate::vello::executor`]) runs it and decides
//! nothing. One packed store holds every value the frame makes: the frame's own rows first,
//! every other value a rect below them. A pass carries everything it needs; the operand records
//! in `params` carry every origin a mark reads through.

use crate::kurbo::{Affine, Rect};

use crate::vello::frame_graph::{DrawItem, ShapeId};

/// The frame's whole GPU program.
#[derive(Clone, Debug, Default)]
pub struct FramePlan {
    /// THE store: one packed r32uint read-write texture, `(width, height)` texels. Rows `[0, h)`
    /// are the frame; every other value is a rect below them. Every `Rect` in this plan is store
    /// texels.
    pub store: (u32, u32),
    /// The page pitch in rows: the frame height rounded up to whole tiles, so every page starts
    /// on a tile row and a tile's writes never straddle two pages. Page `p` holds frame pixel
    /// `(x, y)` at store `(x, y + p·page)`; the rows past the frame in each page are slack.
    pub page: u32,
    /// One buffer, uploaded once: descriptors (26-float header + operand records per arm) and
    /// sparse tile lists, addressed by the offsets the passes and markers carry.
    pub params: Vec<f32>,
    /// Executed in order into one encoder.
    pub passes: Vec<Pass>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Pass {
    /// Fill `rect` with a straight colour.
    Clear { rect: Rect, colour: [f32; 4] },
    /// vello's front-end + binning + coarse over `draws`, once — the PTCL every `Fine` walks.
    Frontend { draws: Vec<DrawCmd> },
    /// One `fine` dispatch over one window. Every operand a mark reads and the rect it writes are
    /// named by its descriptor's records in `params`; the store is the only binding. `work` is
    /// the [`work`] kinds the window runs — a label for the profiler's buckets, never branched on.
    Fine { window: Window, work: u32 },
    /// Copy `src` to `dst` (same size, disjoint).
    Copy { src: Rect, dst: Rect },
    /// Unpack `from` onto the swapchain.
    Present { from: Rect },
}

/// The kinds of work a `Fine` window runs, as bits of `Pass::Fine::work`.
pub mod work {
    pub const SCALE: u32 = 1;
    pub const WARP: u32 = 2;
    pub const BLUR: u32 = 4;
    pub const SCATTER: u32 = 8;
    /// Shade, mask-mix, erase, colour, clip-to-source and every compose.
    pub const POINTWISE: u32 = 16;
    /// A leaf or ground drawn into its rect this round.
    pub const DRAW: u32 = 32;
    /// The frame's own paint: round 0 over every tile.
    pub const PAINT: u32 = 64;
}

#[derive(Clone, Debug, PartialEq)]
pub enum DrawCmd {
    /// Draw `items` under `transform` (page → store, the viewport applied by the backend). A
    /// served ground is this under a translated transform.
    Shapes { items: Vec<DrawItem>, transform: Affine },
    /// Every draw until the matching `Unclip` is clipped to `rect` (store texels, whole tiles).
    /// Coarse drops the clip on the tiles it covers and every draw inside it on the tiles it
    /// misses, so its only cost is one path's tile records: one clip serves any number of draws.
    /// A rect that covers its tiles only partly would reach fine as clip commands, and a clip
    /// that opens in one window and closes in another cannot be run there — so a clip spanning
    /// markers must be tile-aligned.
    Clip { rect: Rect },
    Unclip,
    /// A `CMD_EFFECT` boundary. `footprint` is the rect coarse bins it into; `shape` and
    /// `transform` give the silhouette a masked marker draws; `params_off` addresses its
    /// descriptor in `params`; `ctl` is its control word.
    Marker {
        shape: ShapeId,
        transform: Affine,
        eid: u32,
        seg_after: u32,
        round: u32,
        footprint: Rect,
        ctl: u32,
        params_off: u32,
    },
}

/// The window one `Fine` runs: rounds `[lo, hi)` over the PTCL's marker rounds (`hi ==`
/// [`crate::vello::rasterize::SEG_ALL`] for the tail), over all tiles or a listed subset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    pub rounds: (u32, u32),
    pub tiles: Tiles,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tiles {
    All,
    /// `n` tile words at `params[off..]`, each `y << 16 | x` biased by `0x4000_0000`.
    List { off: u32, n: u32 },
}

/// The work a plan does — what the shape gate counts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlanShape {
    /// Distinct rects drawn or written outside a masked compose: leaf rects and page arm outputs.
    pub rects: u32,
    pub draws: u32,
    pub markers: u32,
    pub windows: u32,
    pub rounds: u32,
}

/// The profiler's name for a window's `work`: its one kind, `paint` when the frame's own paint
/// is in it, `mixed` for several kinds, `idle` for none.
#[must_use]
pub fn work_label(work: u32) -> &'static str {
    if work & work::PAINT != 0 {
        return "paint";
    }
    match work {
        0 => "idle",
        work::SCALE => "scale",
        work::WARP => "warp",
        work::BLUR => "blur",
        work::SCATTER => "scatter",
        work::POINTWISE => "pointwise",
        work::DRAW => "draw",
        _ => "mixed",
    }
}

fn rect_i(r: Rect) -> [i64; 4] {
    [r.x0 as i64, r.y0 as i64, r.x1 as i64, r.y1 as i64]
}

fn disjoint(a: Rect, b: Rect) -> bool {
    a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0
}

impl FramePlan {
    #[must_use]
    pub fn shape(&self) -> PlanShape {
        let mut s = PlanShape::default();
        let mut rects: Vec<[i64; 4]> = Vec::new();
        let frame = self.passes.iter().find_map(|p| match p {
            Pass::Present { from } => Some(rect_i(*from)),
            _ => None,
        });
        let holds_frame = |r: Rect| frame.is_some_and(|f| rect_i(r).iter().zip(f).enumerate().all(|(i, (a, b))| if i < 2 { a <= &b } else { a >= &b }));
        let mut note = |r: Rect| {
            let k = rect_i(r);
            if !holds_frame(r) && !rects.contains(&k) {
                rects.push(k);
            }
        };
        for p in &self.passes {
            match p {
                Pass::Frontend { draws } => {
                    for d in draws {
                        match d {
                            DrawCmd::Shapes { items, .. } => s.draws += items.len() as u32,
                            DrawCmd::Clip { rect } => note(*rect),
                            DrawCmd::Unclip => {}
                            DrawCmd::Marker { eid, footprint, .. } => {
                                s.markers += 1;
                                if *eid == crate::vello::bake::EID_MATERIALIZE {
                                    note(*footprint);
                                }
                            }
                        }
                    }
                }
                Pass::Fine { window, .. } => {
                    s.windows += 1;
                    s.rounds = s.rounds.max(window.rounds.0 + 1);
                }
                _ => {}
            }
        }
        s.rects = rects.len() as u32;
        s
    }

    /// The plan as text: the store, then one line per pass with its draws and windows.
    #[must_use]
    pub fn dump(&self) -> String {
        let r = |x: Rect| format!("[{:.0} {:.0} {:.0} {:.0}]", x.x0, x.y0, x.x1, x.y1);
        let mut s = format!("store {}x{} params {} floats\n", self.store.0, self.store.1, self.params.len());
        for (i, p) in self.passes.iter().enumerate() {
            match p {
                Pass::Clear { rect, colour } => s.push_str(&format!("{i:>3} Clear {} {colour:.2?}\n", r(*rect))),
                Pass::Frontend { draws } => {
                    s.push_str(&format!("{i:>3} Frontend {} draws\n", draws.len()));
                    for d in draws {
                        match d {
                            DrawCmd::Shapes { items, transform } => {
                                let t = transform.as_coeffs();
                                s.push_str(&format!("      Shapes n={} at +{:.0},{:.0}\n", items.len(), t[4], t[5]));
                            }
                            DrawCmd::Clip { rect } => s.push_str(&format!("      Clip {}\n", r(*rect))),
                            DrawCmd::Unclip => s.push_str("      Unclip\n"),
                            DrawCmd::Marker { shape, eid, round, footprint, params_off, .. } => {
                                s.push_str(&format!("      Marker eid {eid} round {round} shape {:x} at {} params {params_off}", shape & 0xffff, r(*footprint)));
                                let o = *params_off as usize;
                                if let Some(d) = self.params.get(o..o + 26 + 48) {
                                    s.push_str(&format!(" bits {} program {} u0 {:.1?}", d[0] as u32, d[1] as u32, &d[2..6]));
                                    for (k, name) in ["value", "ref", "cov", "dist", "out"].iter().enumerate() {
                                        let rec = &d[26 + k * 8..26 + k * 8 + 8];
                                        if rec[0] != 0.0 {
                                            s.push_str(&format!(" {name}=src{:.0}[{:.0} {:.0} {:.0} {:.0}]+{:.0},{:.0}", rec[0], rec[1], rec[2], rec[3], rec[4], rec[5], rec[6]));
                                        }
                                    }
                                }
                                s.push('\n');
                            }
                        }
                    }
                }
                Pass::Fine { window, work } => {
                    let tiles = match window.tiles {
                        Tiles::All => "all".to_string(),
                        Tiles::List { n, .. } => format!("{n} tiles"),
                    };
                    s.push_str(&format!("{i:>3} Fine rounds {:?} {tiles} work {}\n", window.rounds, work_label(*work)));
                }
                Pass::Copy { src, dst } => s.push_str(&format!("{i:>3} Copy {} -> {}\n", r(*src), r(*dst))),
                Pass::Present { from } => s.push_str(&format!("{i:>3} Present {}\n", r(*from))),
            }
        }
        s
    }

    /// What the executor refuses to run: a rect outside the store, a `Copy` onto itself, a window
    /// with `hi <= lo`.
    pub fn validate(&self) -> Result<(), String> {
        let store = Rect::new(0.0, 0.0, f64::from(self.store.0), f64::from(self.store.1));
        if self.page == 0 || self.page % 16 != 0 || self.store.1 % self.page != 0 {
            return Err(format!("page pitch {} does not tile the store {:?}", self.page, self.store));
        }
        let inside = |r: Rect, what: &str| -> Result<(), String> {
            if r.x0 < store.x0 || r.y0 < store.y0 || r.x1 > store.x1 || r.y1 > store.y1 || r.x1 <= r.x0 || r.y1 <= r.y0 {
                return Err(format!("{what} {r:?} is outside the store {store:?}"));
            }
            Ok(())
        };
        for (i, p) in self.passes.iter().enumerate() {
            match p {
                Pass::Clear { rect, .. } => inside(*rect, "clear")?,
                Pass::Frontend { draws } => {
                    let mut depth = 0i32;
                    for d in draws {
                        match d {
                            DrawCmd::Clip { rect } => {
                                inside(*rect, "clip")?;
                                if [rect.x0, rect.y0, rect.x1, rect.y1].iter().any(|v| v % 16.0 != 0.0) {
                                    return Err(format!("pass {i}: clip {rect:?} is not tile-aligned"));
                                }
                                depth += 1;
                            }
                            DrawCmd::Unclip => {
                                depth -= 1;
                                if depth < 0 {
                                    return Err(format!("pass {i}: an Unclip with no Clip open"));
                                }
                            }
                            _ => {}
                        }
                    }
                    if depth != 0 {
                        return Err(format!("pass {i}: {depth} clips left open"));
                    }
                }
                Pass::Fine { window, .. } => {
                    if window.rounds.1 <= window.rounds.0 {
                        return Err(format!("pass {i}: window {:?} is empty", window.rounds));
                    }
                }
                Pass::Copy { src, dst } => {
                    inside(*src, "copy src")?;
                    inside(*dst, "copy dst")?;
                    if (src.width() - dst.width()).abs() > 0.5 || (src.height() - dst.height()).abs() > 0.5 {
                        return Err(format!("pass {i}: copy {src:?} -> {dst:?} changes size"));
                    }
                    if !disjoint(*src, *dst) {
                        return Err(format!("pass {i}: copy {src:?} -> {dst:?} overlaps"));
                    }
                }
                Pass::Present { from } => inside(*from, "present")?,
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_frame_plan_validates_and_counts_no_rects() {
        let frame = Rect::new(0.0, 0.0, 64.0, 32.0);
        let plan = FramePlan {
            store: (64, 32),
            page: 32,
            params: vec![],
            passes: vec![
                Pass::Clear { rect: frame, colour: [1.0; 4] },
                Pass::Frontend { draws: vec![] },
                Pass::Fine { window: Window { rounds: (0, u32::MAX), tiles: Tiles::All }, work: work::PAINT },
                Pass::Present { from: frame },
            ],
        };
        plan.validate().expect("valid");
        assert_eq!(plan.shape(), PlanShape { rects: 0, draws: 0, markers: 0, windows: 1, rounds: 1 });
    }

    #[test]
    fn an_unbalanced_clip_is_refused() {
        let frame = Rect::new(0.0, 0.0, 64.0, 32.0);
        let plan = FramePlan {
            store: (64, 32),
            page: 32,
            params: vec![],
            passes: vec![Pass::Frontend { draws: vec![DrawCmd::Clip { rect: frame }] }],
        };
        assert!(plan.validate().is_err());
        let plan = FramePlan {
            store: (64, 32),
            page: 32,
            params: vec![],
            passes: vec![Pass::Frontend { draws: vec![DrawCmd::Unclip] }],
        };
        assert!(plan.validate().is_err());
    }

    #[test]
    fn an_overlapping_copy_is_refused() {
        let plan = FramePlan {
            store: (64, 64),
            page: 64,
            params: vec![],
            passes: vec![Pass::Copy { src: Rect::new(0.0, 0.0, 64.0, 32.0), dst: Rect::new(0.0, 16.0, 64.0, 48.0) }],
        };
        assert!(plan.validate().is_err());
    }
}
