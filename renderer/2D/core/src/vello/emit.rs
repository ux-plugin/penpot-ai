//! Step 7b: the passes. Clear (the frame to the background, the pages to transparent), one
//! front-end over the spine in z-order (clipped to the frame once pages sit under it, so a shape
//! reaching past the frame's bottom never paints a page) with a marker at every compose, then
//! the page work in round order: each leaf and halo root draw behind its boundary marker (each
//! clipped to its store rect), a halo spine's draws and compose markers under the halo's
//! transform, and a marker per page arm; before each round's fine, the clears of the rects drawn
//! in it (a leaf's to transparent, a halo's to the background — the tiles may have held an
//! earlier value) and the copies filling the halos whose node became ready the round before;
//! one fine per round over that round's tiles; present. `params` gains one tile list per round.

use crate::kurbo::{Affine, Rect, Vec2};

use crate::vello::arms::{Kind, Work};
use crate::vello::bake;
use crate::vello::frame_graph::{scale_rect, Op};
use crate::vello::frame_plan::{self, DrawCmd, FramePlan, Pass, Tiles, Window};
use crate::vello::params::Params;
use crate::vello::resolve::{tile_round, Resolved};
use crate::vello::schedule::Schedule;
use crate::vello::scheduler::{TILE_H, TILE_W};

fn tiles_of(r: Rect, out: &mut Vec<u32>) {
    let r = tile_round(r);
    let (x0, y0, x1, y1) = ((r.x0 / TILE_W) as u32, (r.y0 / TILE_H) as u32, (r.x1 / TILE_W) as u32, (r.y1 / TILE_H) as u32);
    for y in y0..y1 {
        for x in x0..x1 {
            out.push(0x4000_0000 | (y << 16) | x);
        }
    }
}

pub(crate) fn emit(cx: &Resolved, work: &Work, s: &Schedule, params: Params) -> FramePlan {
    let Params { floats: mut params, arms: ops } = params;
    let pages = s.pages(cx, work);
    let pitch = cx.store.pitch;
    let store_h = pitch * (1 + pages) as f64;
    let rounds = s.round.iter().map(|r| r + 1).max().unwrap_or(1);

    let mut draws: Vec<DrawCmd> = Vec::new();
    let mut copies: Vec<Vec<Pass>> = vec![Vec::new(); rounds as usize + 1];
    let mut tiles: Vec<Vec<u32>> = vec![Vec::new(); rounds as usize];
    tiles_of(cx.store.frame, &mut tiles[0]);
    let mut work_word: Vec<u32> = vec![0; rounds as usize];
    work_word[0] |= frame_plan::work::PAINT;
    for (a, arm) in work.arms.iter().enumerate() {
        let w = &mut work_word[s.round[a] as usize];
        for &i in &arm.nodes {
            *w |= match &cx.g.nodes[i].op {
                Op::Resample { .. } | Op::Halo { .. } => frame_plan::work::RESAMPLE,
                Op::Warp(_) => frame_plan::work::WARP,
                Op::Blur { .. } => frame_plan::work::BLUR,
                Op::Scatter(_) => frame_plan::work::SCATTER,
                _ => frame_plan::work::POINTWISE,
            };
        }
        if arm.compose.is_some() {
            *w |= frame_plan::work::POINTWISE;
        }
    }
    let mut page_work: Vec<(u32, u32, Vec<DrawCmd>)> = Vec::new();
    for (vi, v) in work.values.iter().enumerate() {
        let rect = s.store_rect(cx, work, vi);
        let birth = s.slot[vi].birth;
        let k = f64::from(cx.res.k[v.node]);
        let origin = s.origin(cx, vi);
        let transform = if k == 1.0 { Affine::translate(origin) } else { Affine::translate(origin) * Affine::scale(k) };
        let items = match &v.kind {
            Kind::Leaf { item, .. } => {
                if birth > 0 {
                    copies[birth as usize].push(Pass::Clear { rect, colour: [0.0; 4] });
                }
                let mut it = item.clone();
                it.bounds = scale_rect(cx.dem.out[v.node], 1.0 / k);
                vec![it]
            }
            Kind::Root(items) => {
                copies[birth as usize].push(Pass::Clear { rect, colour: cx.g.background.components });
                items.clone()
            }
            Kind::Rows | Kind::Silhouette(_) | Kind::Out => continue,
        };
        tiles_of(rect, &mut tiles[birth as usize]);
        work_word[birth as usize] |= frame_plan::work::DRAW;
        let mut cmds = Vec::new();
        if birth > 0 {
            cmds.push(DrawCmd::Marker { shape: 0, transform: Affine::IDENTITY, eid: bake::EID_BOUNDARY, seg_after: birth, round: birth, footprint: rect, ctl: 0, params_off: 0 });
        }
        cmds.push(DrawCmd::Clip { rect });
        cmds.push(DrawCmd::Shapes { items, transform });
        cmds.push(DrawCmd::Unclip);
        page_work.push((birth, 0, cmds));
    }
    for i in 0..cx.g.nodes.len() {
        let (Some(h), Op::Draw(_)) = (cx.spines.halo_of[i], &cx.g.nodes[i].op) else { continue };
        if cx.g.nodes[i].inputs.is_empty() || !cx.live(i) {
            continue;
        }
        let items = cx.dem.kept[i].clone();
        if items.is_empty() {
            continue;
        }
        let v = work.value_of[h].expect("a live halo has a value");
        let birth = s.slot[v].birth;
        let origin = s.origin(cx, v);
        let k = f64::from(cx.res.k[i]);
        let rect = cx.dem.out[i] + origin;
        let round = s.ready(cx, work, i, cx.dem.out[i]).max(birth);
        tiles_of(rect, &mut tiles[round as usize]);
        work_word[round as usize] |= frame_plan::work::DRAW;
        let transform = Affine::translate(origin) * Affine::scale(k);
        page_work.push((round, if round > birth { 2 } else { 0 }, vec![DrawCmd::Clip { rect }, DrawCmd::Shapes { items, transform }, DrawCmd::Unclip]));
    }
    for h in 0..cx.g.nodes.len() {
        let Op::Halo { of } = cx.g.nodes[h].op else { continue };
        if !cx.live(h) || cx.res.k[of] != cx.res.k[h] || !cx.fill_read(h) {
            continue;
        }
        let inside = cx.inside_of(h, cx.dem.out[h]);
        if inside.is_zero_area() {
            continue;
        }
        let v = work.value_of[h].expect("a live halo has a value");
        let copy_round = s.ready(cx, work, h, inside).max(s.slot[v].birth);
        if (copy_round as usize) < rounds as usize {
            let src_origin = work.value_of[of].map_or(Vec2::ZERO, |w| s.origin(cx, w));
            copies[copy_round as usize + 1].push(Pass::Copy { src: inside + src_origin, dst: inside + s.origin(cx, v) });
        }
    }
    if pages > 0 {
        draws.push(DrawCmd::Clip { rect: Rect::new(0.0, 0.0, cx.store.width, pitch) });
    }
    for i in 0..cx.g.nodes.len() {
        if !cx.live(i) || !cx.g.is_spine(i) || cx.spines.halo_of[i].is_some() {
            continue;
        }
        match &cx.g.nodes[i].op {
            Op::Draw(_) => {
                let items = cx.dem.kept[i].clone();
                if items.is_empty() {
                    continue;
                }
                draws.push(DrawCmd::Shapes { items, transform: Affine::IDENTITY });
            }
            Op::Compose { .. } => {
                let a = work.arm_of[i].expect("a live compose has an arm");
                let footprint = cx.dem.out[i];
                tiles_of(footprint, &mut tiles[s.round[a] as usize]);
                draws.push(DrawCmd::Marker {
                    shape: ops[a].mask_shape.unwrap_or(0),
                    transform: Affine::IDENTITY,
                    eid: if ops[a].mask_shape.is_some() { bake::EID_MASKED } else { bake::EID_MATERIALIZE },
                    seg_after: s.round[a],
                    round: s.round[a],
                    footprint,
                    ctl: 0,
                    params_off: ops[a].off,
                });
            }
            _ => {}
        }
    }
    if pages > 0 {
        draws.push(DrawCmd::Unclip);
    }
    for i in 0..cx.g.nodes.len() {
        let (Some(h), Op::Compose { .. }) = (cx.spines.halo_of[i], &cx.g.nodes[i].op) else { continue };
        if !cx.live(i) {
            continue;
        }
        let a = work.arm_of[i].expect("a live compose has an arm");
        let vh = work.value_of[h].expect("a live halo has a value");
        let origin = s.origin(cx, vh);
        let k = f64::from(cx.res.k[i]);
        let footprint = cx.dem.out[i] + origin;
        tiles_of(footprint, &mut tiles[s.round[a] as usize]);
        let marker = DrawCmd::Marker {
            shape: ops[a].mask_shape.unwrap_or(0),
            transform: Affine::translate(origin) * Affine::scale(k),
            eid: if ops[a].mask_shape.is_some() { bake::EID_MASKED } else { bake::EID_MATERIALIZE },
            seg_after: s.round[a],
            round: s.round[a],
            footprint,
            ctl: 0,
            params_off: ops[a].off,
        };
        page_work.push((s.round[a], 1, vec![marker]));
    }
    for a in (0..work.arms.len()).filter(|&a| work.arms[a].compose.is_none()) {
        let footprint = s.store_rect(cx, work, work.arms[a].out);
        tiles_of(footprint, &mut tiles[s.round[a] as usize]);
        let marker = DrawCmd::Marker { shape: 0, transform: Affine::IDENTITY, eid: bake::EID_MATERIALIZE, seg_after: s.round[a], round: s.round[a], footprint, ctl: 0, params_off: ops[a].off };
        page_work.push((s.round[a], 1, vec![marker]));
    }
    page_work.sort_by_key(|w| (w.0, w.1));
    draws.extend(page_work.into_iter().flat_map(|w| w.2));

    let mut passes = vec![Pass::Clear { rect: cx.store.frame, colour: cx.g.background.components }];
    if pages > 0 {
        passes.push(Pass::Clear { rect: Rect::new(0.0, cx.store.frame.y1, cx.store.width, store_h), colour: [0.0; 4] });
    }
    passes.push(Pass::Frontend { draws });
    for (r, list) in tiles.iter_mut().enumerate() {
        passes.append(&mut copies[r]);
        list.sort_unstable();
        list.dedup();
        let off = params.len() as u32;
        params.extend(list.iter().map(|&w| f32::from_bits(w)));
        let r = r as u32;
        passes.push(Pass::Fine { window: Window { rounds: (r, r + 1), tiles: Tiles::List { off, n: list.len() as u32 } }, work: work_word[r as usize] });
    }
    passes.push(Pass::Present { from: cx.store.frame });
    FramePlan { store: (cx.store.width as u32, store_h as u32), page: pitch as u32, params, passes }
}
