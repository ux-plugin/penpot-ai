// ── Benchmarks ──────────────────────────────────────────────────────────

#[cfg(test)]
mod bench {
    use super::super::*;
    use std::time::Instant;

    fn make_uuid(n: u64) -> Uuid {
        Uuid::from_u64_pair(0, n)
    }

    #[test]
    fn bench_tilegrid_add_1k() {
        tilegrid_add_n(1_000);
    }

    #[test]
    fn bench_tilegrid_add_10k() {
        tilegrid_add_n(10_000);
    }

    #[test]
    fn bench_tilegrid_add_50k() {
        tilegrid_add_n(50_000);
    }

    fn tilegrid_add_n(n: usize) {
        let scale = 1.0;
        let tile_size = tiles::get_tile_size(scale);
        let mut grid = TileGrid::new();

        let start = Instant::now();
        for i in 0..n {
            let id = make_uuid(i as u64);
            let x = (i % 200) as f32 * 50.0;
            let y = (i / 200) as f32 * 50.0;
            let rect = skia::Rect::from_xywh(x, y, 100.0, 80.0);
            let tile_rect = tiles::get_tiles_for_rect(rect, tile_size);

            for tx in tile_rect.x1()..=tile_rect.x2() {
                for ty in tile_rect.y1()..=tile_rect.y2() {
                    grid.add_shape_at(
                        Tile::from(tx, ty),
                        ShapeEntry {
                            id,
                            z_index: i as i32,
                            paint_order: i as u32,
                            has_gather: false,
                        },
                    );
                }
            }
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] TileGrid add {n} shapes: {:.3}ms ({:.1}µs/shape)",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1_000_000.0 / n as f64
        );
    }

    #[test]
    fn bench_tilegrid_move_1k() {
        tilegrid_move_n(1_000);
    }

    #[test]
    fn bench_tilegrid_move_10k() {
        tilegrid_move_n(10_000);
    }

    fn tilegrid_move_n(n: usize) {
        let scale = 1.0;
        let tile_size = tiles::get_tile_size(scale);
        let mut grid = TileGrid::new();

        // Setup
        for i in 0..n {
            let id = make_uuid(i as u64);
            let x = (i % 200) as f32 * 50.0;
            let y = (i / 200) as f32 * 50.0;
            let rect = skia::Rect::from_xywh(x, y, 100.0, 80.0);
            let tile_rect = tiles::get_tiles_for_rect(rect, tile_size);
            for tx in tile_rect.x1()..=tile_rect.x2() {
                for ty in tile_rect.y1()..=tile_rect.y2() {
                    grid.add_shape_at(
                        Tile::from(tx, ty),
                        ShapeEntry {
                            id,
                            z_index: i as i32,
                            paint_order: i as u32,
                            has_gather: false,
                        },
                    );
                }
            }
        }

        // Benchmark: move each shape by (10, 10)
        let start = Instant::now();
        for i in 0..n {
            let id = make_uuid(i as u64);
            let old_x = (i % 200) as f32 * 50.0;
            let old_y = (i / 200) as f32 * 50.0;
            let new_x = old_x + 10.0;
            let new_y = old_y + 10.0;

            let old_rect = skia::Rect::from_xywh(old_x, old_y, 100.0, 80.0);
            let old_tiles = tiles::get_tiles_for_rect(old_rect, tile_size);
            for tx in old_tiles.x1()..=old_tiles.x2() {
                for ty in old_tiles.y1()..=old_tiles.y2() {
                    grid.remove_shape_at(Tile::from(tx, ty), id);
                }
            }

            let new_rect = skia::Rect::from_xywh(new_x, new_y, 100.0, 80.0);
            let new_tiles = tiles::get_tiles_for_rect(new_rect, tile_size);
            for tx in new_tiles.x1()..=new_tiles.x2() {
                for ty in new_tiles.y1()..=new_tiles.y2() {
                    grid.add_shape_at(
                        Tile::from(tx, ty),
                        ShapeEntry {
                            id,
                            z_index: i as i32,
                            paint_order: i as u32,
                            has_gather: false,
                        },
                    );
                }
            }
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] TileGrid move {n} shapes: {:.3}ms ({:.1}µs/shape)",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1_000_000.0 / n as f64
        );
    }

    #[test]
    fn bench_tilegrid_query_viewport() {
        let scale = 1.0;
        let tile_size = tiles::get_tile_size(scale);
        let n = 10_000;
        let mut grid = TileGrid::new();

        for i in 0..n {
            let id = make_uuid(i as u64);
            let x = (i % 200) as f32 * 50.0;
            let y = (i / 200) as f32 * 50.0;
            let rect = skia::Rect::from_xywh(x, y, 100.0, 80.0);
            let tile_rect = tiles::get_tiles_for_rect(rect, tile_size);
            for tx in tile_rect.x1()..=tile_rect.x2() {
                for ty in tile_rect.y1()..=tile_rect.y2() {
                    grid.add_shape_at(
                        Tile::from(tx, ty),
                        ShapeEntry {
                            id,
                            z_index: i as i32,
                            paint_order: i as u32,
                            has_gather: false,
                        },
                    );
                }
            }
        }

        let viewport = skia::Rect::from_xywh(500.0, 500.0, 1920.0, 1080.0);
        let visible_tiles = tiles::get_tiles_for_rect(viewport, tile_size);
        let tile_count =
            (visible_tiles.width() + 1) as usize * (visible_tiles.height() + 1) as usize;

        let iterations = 100;
        let start = Instant::now();
        let mut total_shapes = 0usize;
        for _ in 0..iterations {
            for tx in visible_tiles.x1()..=visible_tiles.x2() {
                for ty in visible_tiles.y1()..=visible_tiles.y2() {
                    if let Some(shapes) = grid.get_shapes_at(Tile::from(tx, ty)) {
                        total_shapes += shapes.len();
                    }
                }
            }
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] TileGrid query viewport ({tile_count} tiles, {n} shapes): \
             {:.3}ms/query, {total_shapes} shape refs over {iterations} iterations",
            elapsed.as_secs_f64() * 1000.0 / iterations as f64
        );
    }

    #[test]
    fn bench_tilegrid_full_rebuild_10k() {
        tilegrid_full_rebuild_n(10_000);
    }

    #[test]
    fn bench_tilegrid_full_rebuild_50k() {
        tilegrid_full_rebuild_n(50_000);
    }

    fn tilegrid_full_rebuild_n(n: usize) {
        let scale = 1.0;
        let tile_size = tiles::get_tile_size(scale);

        let rects: Vec<_> = (0..n)
            .map(|i| {
                let x = (i % 200) as f32 * 50.0;
                let y = (i / 200) as f32 * 50.0;
                (
                    make_uuid(i as u64),
                    skia::Rect::from_xywh(x, y, 100.0, 80.0),
                )
            })
            .collect();

        let iterations = 10;
        let start = Instant::now();
        for _ in 0..iterations {
            let mut grid = TileGrid::new();
            for (i, (id, rect)) in rects.iter().enumerate() {
                let tile_rect = tiles::get_tiles_for_rect(*rect, tile_size);
                for tx in tile_rect.x1()..=tile_rect.x2() {
                    for ty in tile_rect.y1()..=tile_rect.y2() {
                        grid.add_shape_at(
                            Tile::from(tx, ty),
                            ShapeEntry {
                                id: *id,
                                z_index: i as i32,
                                paint_order: i as u32,
                                has_gather: false,
                            },
                        );
                    }
                }
            }
            grid.invalidate();
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] TileGrid full rebuild {n} shapes: {:.3}ms/rebuild",
            elapsed.as_secs_f64() * 1000.0 / iterations as f64
        );
    }

    #[test]
    fn bench_tilegrid_single_shape_drag_latency() {
        let scale = 1.0;
        let tile_size = tiles::get_tile_size(scale);
        let n = 10_000;
        let mut grid = TileGrid::new();

        for i in 0..n {
            let id = make_uuid(i as u64);
            let x = (i % 200) as f32 * 50.0;
            let y = (i / 200) as f32 * 50.0;
            let rect = skia::Rect::from_xywh(x, y, 100.0, 80.0);
            let tile_rect = tiles::get_tiles_for_rect(rect, tile_size);
            for tx in tile_rect.x1()..=tile_rect.x2() {
                for ty in tile_rect.y1()..=tile_rect.y2() {
                    grid.add_shape_at(
                        Tile::from(tx, ty),
                        ShapeEntry {
                            id,
                            z_index: i as i32,
                            paint_order: i as u32,
                            has_gather: false,
                        },
                    );
                }
            }
        }

        let drag_id = make_uuid(500);
        let iterations = 1000;
        let mut x = 250.0_f32 * 50.0;
        let y = 2.0_f32 * 50.0;

        let start = Instant::now();
        for _ in 0..iterations {
            let old_rect = skia::Rect::from_xywh(x, y, 100.0, 80.0);
            let old_tiles = tiles::get_tiles_for_rect(old_rect, tile_size);
            for tx in old_tiles.x1()..=old_tiles.x2() {
                for ty in old_tiles.y1()..=old_tiles.y2() {
                    grid.remove_shape_at(Tile::from(tx, ty), drag_id);
                }
            }
            x += 2.0;
            let new_rect = skia::Rect::from_xywh(x, y, 100.0, 80.0);
            let new_tiles = tiles::get_tiles_for_rect(new_rect, tile_size);
            for tx in new_tiles.x1()..=new_tiles.x2() {
                for ty in new_tiles.y1()..=new_tiles.y2() {
                    grid.add_shape_at(
                        Tile::from(tx, ty),
                        ShapeEntry {
                            id: drag_id,
                            z_index: 500,
                            paint_order: 500,
                            has_gather: false,
                        },
                    );
                }
            }
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] TileGrid single shape drag ({n} scene, {iterations} moves): \
             {:.3}ms total, {:.1}µs/move",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1_000_000.0 / iterations as f64
        );
    }

    #[test]
    fn bench_tilegrid_spiral_generation() {
        let sizes = [(5, 4), (10, 8), (20, 15), (40, 30)];

        for (w, h) in sizes {
            let rect = TileRect(0, 0, w, h);
            let total = (w + 1) * (h + 1);

            let iterations = 1000;
            let start = Instant::now();
            for _ in 0..iterations {
                let _ = TileGrid::generate_spiral(&rect);
            }
            let elapsed = start.elapsed();
            println!(
                "[bench] TileGrid spiral {w}x{h} ({total} tiles): {:.3}ms/gen",
                elapsed.as_secs_f64() * 1000.0 / iterations as f64
            );
        }
    }

    #[test]
    fn bench_tilegrid_topological_sort() {
        // Create a scenario with gather dependencies
        let mut grid = TileGrid::new();
        let scale = 1.0;
        let tile_size = tiles::get_tile_size(scale);

        // Add 1000 normal shapes
        for i in 0..1000 {
            let id = make_uuid(i as u64);
            let x = (i % 50) as f32 * 200.0;
            let y = (i / 50) as f32 * 200.0;
            let rect = skia::Rect::from_xywh(x, y, 100.0, 80.0);
            let tile_rect = tiles::get_tiles_for_rect(rect, tile_size);
            for tx in tile_rect.x1()..=tile_rect.x2() {
                for ty in tile_rect.y1()..=tile_rect.y2() {
                    grid.add_shape_at(
                        Tile::from(tx, ty),
                        ShapeEntry {
                            id,
                            z_index: i as i32,
                            paint_order: i as u32,
                            has_gather: false,
                        },
                    );
                }
            }
        }

        // Add 5 gather shapes spanning multiple tiles
        for i in 0..5 {
            let id = make_uuid(10000 + i as u64);
            let x = (i * 3) as f32 * 200.0;
            let rect = skia::Rect::from_xywh(x, 0.0, 800.0, 600.0);
            let tile_rect = tiles::get_tiles_for_rect(rect, tile_size);
            for tx in tile_rect.x1()..=tile_rect.x2() {
                for ty in tile_rect.y1()..=tile_rect.y2() {
                    grid.add_shape_at(
                        Tile::from(tx, ty),
                        ShapeEntry {
                            id,
                            z_index: 5000 + i as i32,
                            paint_order: 5000 + i as u32,
                            has_gather: true,
                        },
                    );
                }
            }
        }

        let interest = TileRect(0, 0, 20, 15);
        let viewbox = crate::view::Viewbox::new(1920.0, 1080.0);
        let tile_viewbox = TileViewbox::new_with_interest(viewbox, 1, scale);

        let spiral = TileGrid::generate_spiral(&interest);

        // Populate bands (1 band per tile — no gather-barrier splits for the
        // synthetic setup below; tests exercise that path separately).
        for (tile, entries) in grid.grid.clone().iter() {
            if entries.is_empty() {
                continue;
            }
            let min = entries.iter().map(|e| e.paint_order).min().unwrap_or(0);
            let max = entries.iter().map(|e| e.paint_order).max().unwrap_or(0);
            grid.bands.insert(
                *tile,
                vec![Band {
                    shapes: entries.iter().map(|e| e.id).collect(),
                    min_paint_order: min,
                    max_paint_order: max,
                    gather_at_head: None,
                }],
            );
        }

        // Build deps manually for benchmark. Keep edges one-directional
        // (dep tile lexicographically less than source tile) so the graph is
        // acyclic — topological_sort's debug_assert requires that.
        let iterations = 100;
        let start = Instant::now();
        for _ in 0..iterations {
            let mut deps: HashMap<BandKey, HashSet<BandKey>> = HashMap::default();
            for (tile, entries) in &grid.grid {
                for entry in entries {
                    if entry.has_gather {
                        for dx in -2..=2 {
                            for dy in -2..=2 {
                                if dx == 0 && dy == 0 {
                                    continue;
                                }
                                let dep = Tile::from(tile.x() + dx, tile.y() + dy);
                                if grid.grid.contains_key(&dep)
                                    && (dep.y(), dep.x()) < (tile.y(), tile.x())
                                {
                                    deps.entry(BandKey::new(*tile, 0))
                                        .or_default()
                                        .insert(BandKey::new(dep, 0));
                                }
                            }
                        }
                    }
                }
            }

            let _ = grid.topological_sort(&spiral, &deps, &tile_viewbox);
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] TileGrid topo sort (1000 shapes, 5 gathers): {:.3}ms/sort",
            elapsed.as_secs_f64() * 1000.0 / iterations as f64
        );
    }

    // ── End-to-end rebuild benches (exercise compute_bands + build_schedule) ──

    fn end_to_end_rebuild(n_shapes: usize, n_gathers: usize, label: &str) {
        use crate::shapes::GlassEffect;
        use crate::state::ShapesPool;
        use crate::view::Viewbox;

        let scale = 1.0;
        let mut pool = ShapesPool::new();
        pool.add_shape(Uuid::nil());

        // Spread non-gather shapes across a tile grid. 100x(n/100) layout.
        for i in 0..n_shapes {
            let id = Uuid::from_u64_pair(1, i as u64);
            let x = (i % 100) as f32 * 60.0;
            let y = (i / 100) as f32 * 60.0;
            let shape = pool.add_shape(id);
            shape.id = id;
            shape.parent_id = Some(Uuid::nil());
            shape.selrect = skia::Rect::from_xywh(x, y, 100.0, 80.0);
            let root = pool.get_mut(&Uuid::nil()).unwrap();
            root.children.push(id);
        }

        // Sprinkle n_gathers glass shapes, each covering ~1000px square
        // (≈ 2x2 tiles at scale 1).
        for i in 0..n_gathers {
            let id = Uuid::from_u64_pair(2, i as u64);
            let x = (i * 300) as f32;
            let y = (i * 300) as f32;
            let shape = pool.add_shape(id);
            shape.id = id;
            shape.parent_id = Some(Uuid::nil());
            shape.selrect = skia::Rect::from_xywh(x, y, 1000.0, 1000.0);
            shape.glass = Some(GlassEffect {
                surface_type: 0,
                bezel_width: 10.0,
                glass_thickness: 1.0,
                refractive_index: 1.0,
                specular_angle: 0.0,
                specular_opacity: 0.0,
                specular_saturation: 0.0,
                chromatic_aberration: 0.0,
                splay: 0.0,
                tilt_angle: 0.0,
                edge_boost: 0.0,
                zoom: 1.0,
                blur: 50.0,
                frost: 0.0,
                hidden: false,
            });
            let root = pool.get_mut(&Uuid::nil()).unwrap();
            root.children.push(id);
        }

        let viewbox = Viewbox::new(6400.0, 6400.0);
        let tv = TileViewbox::new_with_interest(viewbox, 1, scale);

        let iterations = 20;
        let mut grid = TileGrid::new();
        // Warmup
        grid.rebuild(&pool, &tv, scale);

        let start = Instant::now();
        for _ in 0..iterations {
            grid.rebuild(&pool, &tv, scale);
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] E2E rebuild {}: {:.3}ms/rebuild (schedule_len={}, total_bands={})",
            label,
            elapsed.as_secs_f64() * 1000.0 / iterations as f64,
            grid.schedule.len(),
            grid.bands.values().map(|v| v.len()).sum::<usize>(),
        );
    }

    #[test]
    fn bench_rebuild_e2e_no_gather() {
        end_to_end_rebuild(1_000, 0, "1k shapes, 0 gathers");
    }

    #[test]
    fn bench_rebuild_e2e_few_gathers() {
        end_to_end_rebuild(1_000, 5, "1k shapes, 5 gathers");
    }

    #[test]
    fn bench_rebuild_e2e_many_gathers() {
        end_to_end_rebuild(1_000, 20, "1k shapes, 20 gathers");
    }

    // ── Tile-scheduler refactor benches: parameterized by (shapes, gathers, scatters) ──
    //
    // Times two phases:
    //   1. Schedule build  — `tile_grid.rebuild` (pure CPU; what the per-effect
    //      refactor changes most).
    //   2. Schedule walk   — `grid.next()` over the entire schedule (no GPU work;
    //      isolates pure scheduler iteration overhead).
    //
    // The "run the rendering" phase that actually paints into Skia surfaces is
    // GPU-bound and lives in the browser; this CPU bench is the part we can
    // reliably measure deterministically before/after the refactor.
    fn end_to_end_rebuild_full(
        n_shapes: usize,
        n_gathers: usize,
        n_scatters: usize,
        label: &str,
    ) {
        use crate::shapes::{GlassEffect, TextureEffect};
        use crate::state::ShapesPool;
        use crate::view::Viewbox;

        let scale = 1.0;
        let mut pool = ShapesPool::new();
        pool.add_shape(Uuid::nil());

        // Plain shapes laid out across a 100-wide grid.
        for i in 0..n_shapes {
            let id = Uuid::from_u64_pair(1, i as u64);
            let x = (i % 100) as f32 * 60.0;
            let y = (i / 100) as f32 * 60.0;
            let shape = pool.add_shape(id);
            shape.id = id;
            shape.parent_id = Some(Uuid::nil());
            shape.selrect = skia::Rect::from_xywh(x, y, 100.0, 80.0);
            let root = pool.get_mut(&Uuid::nil()).unwrap();
            root.children.push(id);
        }

        // Gather (glass) shapes — root-level so they trigger the gather barrier.
        for i in 0..n_gathers {
            let id = Uuid::from_u64_pair(2, i as u64);
            let x = (i * 300) as f32;
            let y = (i * 300) as f32;
            let shape = pool.add_shape(id);
            shape.id = id;
            shape.parent_id = Some(Uuid::nil());
            shape.selrect = skia::Rect::from_xywh(x, y, 1000.0, 1000.0);
            shape.glass = Some(GlassEffect {
                surface_type: 0,
                bezel_width: 10.0,
                glass_thickness: 1.0,
                refractive_index: 1.0,
                specular_angle: 0.0,
                specular_opacity: 0.0,
                specular_saturation: 0.0,
                chromatic_aberration: 0.0,
                splay: 0.0,
                tilt_angle: 0.0,
                edge_boost: 0.0,
                zoom: 1.0,
                blur: 50.0,
                frost: 0.0,
                hidden: false,
            });
            let root = pool.get_mut(&Uuid::nil()).unwrap();
            root.children.push(id);
        }

        // Scatter (texture) shapes — not gather-classified but they exercise the
        // scatter cache codepath (BuildCache + per-tile blit after the refactor).
        for i in 0..n_scatters {
            let id = Uuid::from_u64_pair(3, i as u64);
            let x = (i * 200) as f32;
            let y = ((i * 200) + 100) as f32;
            let shape = pool.add_shape(id);
            shape.id = id;
            shape.parent_id = Some(Uuid::nil());
            shape.selrect = skia::Rect::from_xywh(x, y, 400.0, 400.0);
            shape.texture = Some(TextureEffect::new(10.0, 5.0, true, false));
            let root = pool.get_mut(&Uuid::nil()).unwrap();
            root.children.push(id);
        }

        let viewbox = Viewbox::new(6400.0, 6400.0);
        let tv = TileViewbox::new_with_interest(viewbox, 1, scale);

        let mut grid = TileGrid::new();
        // Warmup pass to prime any caches.
        grid.rebuild(&pool, &tv, scale);

        // Phase 1: schedule build.
        let rebuild_iters = 20;
        let start = Instant::now();
        for _ in 0..rebuild_iters {
            grid.rebuild(&pool, &tv, scale);
        }
        let rebuild_elapsed = start.elapsed();

        // Phase 2: schedule walk (no GPU; pure cursor advance).
        let walk_iters = 100;
        let start = Instant::now();
        for _ in 0..walk_iters {
            grid.reset();
            while grid.next().is_some() {}
        }
        let walk_elapsed = start.elapsed();

        let total_bands = grid.bands.values().map(|v| v.len()).sum::<usize>();
        println!(
            "[bench] e2e {label}: rebuild={:.3}ms/iter, walk={:.3}µs/walk, \
             schedule_len={}, bands={total_bands}",
            rebuild_elapsed.as_secs_f64() * 1000.0 / rebuild_iters as f64,
            walk_elapsed.as_secs_f64() * 1_000_000.0 / walk_iters as f64,
            grid.schedule.len(),
        );
    }

    #[test]
    fn bench_rebuild_full_1k_baseline() {
        end_to_end_rebuild_full(1_000, 0, 0, "1k shapes, 0 gathers, 0 scatters");
    }

    #[test]
    fn bench_rebuild_full_1k_5_scatters() {
        end_to_end_rebuild_full(1_000, 0, 5, "1k shapes, 0 gathers, 5 scatters");
    }

    #[test]
    fn bench_rebuild_full_1k_5_gathers_5_scatters() {
        end_to_end_rebuild_full(1_000, 5, 5, "1k shapes, 5 gathers, 5 scatters");
    }

    #[test]
    fn bench_rebuild_full_10k_baseline() {
        end_to_end_rebuild_full(10_000, 0, 0, "10k shapes, 0 gathers, 0 scatters");
    }

    #[test]
    fn bench_rebuild_full_10k_with_effects() {
        end_to_end_rebuild_full(10_000, 20, 20, "10k shapes, 20 gathers, 20 scatters");
    }

    // ── Interaction benches: drag / pan-sweep / zoom-sweep with effects ─────
    //
    // These build a scene like `end_to_end_rebuild_full`, then call
    // `grid.rebuild(...)` once per frame after either mutating one shape's
    // `selrect` (drag) or the `Viewbox` (pan / zoom). Reported metric is
    // CPU time per frame — the cost the browser pays each animation frame
    // during interaction.

    fn build_drag_scene(
        n_shapes: usize,
        n_gathers: usize,
        n_scatters: usize,
    ) -> (crate::state::ShapesPool, Vec<Uuid>, Vec<Uuid>, Vec<Uuid>) {
        use crate::shapes::{GlassEffect, TextureEffect};
        use crate::state::ShapesPool;

        let mut pool = ShapesPool::new();
        pool.add_shape(Uuid::nil());

        let mut plain = Vec::with_capacity(n_shapes);
        let mut gathers = Vec::with_capacity(n_gathers);
        let mut scatters = Vec::with_capacity(n_scatters);

        for i in 0..n_shapes {
            let id = Uuid::from_u64_pair(1, i as u64);
            let x = (i % 100) as f32 * 60.0;
            let y = (i / 100) as f32 * 60.0;
            let shape = pool.add_shape(id);
            shape.id = id;
            shape.parent_id = Some(Uuid::nil());
            shape.selrect = skia::Rect::from_xywh(x, y, 100.0, 80.0);
            pool.get_mut(&Uuid::nil()).unwrap().children.push(id);
            plain.push(id);
        }

        for i in 0..n_gathers {
            let id = Uuid::from_u64_pair(2, i as u64);
            let x = (i * 300) as f32;
            let y = (i * 300) as f32;
            let shape = pool.add_shape(id);
            shape.id = id;
            shape.parent_id = Some(Uuid::nil());
            shape.selrect = skia::Rect::from_xywh(x, y, 1000.0, 1000.0);
            shape.glass = Some(GlassEffect {
                surface_type: 0,
                bezel_width: 10.0,
                glass_thickness: 1.0,
                refractive_index: 1.0,
                specular_angle: 0.0,
                specular_opacity: 0.0,
                specular_saturation: 0.0,
                chromatic_aberration: 0.0,
                splay: 0.0,
                tilt_angle: 0.0,
                edge_boost: 0.0,
                zoom: 1.0,
                blur: 50.0,
                frost: 0.0,
                hidden: false,
            });
            pool.get_mut(&Uuid::nil()).unwrap().children.push(id);
            gathers.push(id);
        }

        for i in 0..n_scatters {
            let id = Uuid::from_u64_pair(3, i as u64);
            let x = (i * 200) as f32;
            let y = ((i * 200) + 100) as f32;
            let shape = pool.add_shape(id);
            shape.id = id;
            shape.parent_id = Some(Uuid::nil());
            shape.selrect = skia::Rect::from_xywh(x, y, 400.0, 400.0);
            shape.texture = Some(TextureEffect::new(10.0, 5.0, true, false));
            pool.get_mut(&Uuid::nil()).unwrap().children.push(id);
            scatters.push(id);
        }

        (pool, plain, gathers, scatters)
    }

    // ── Test 1: drag a plain shape with gather/scatter shapes present ───────

    fn drag_plain_shape_with_effects(
        n_shapes: usize,
        n_gathers: usize,
        n_scatters: usize,
        label: &str,
    ) {
        use crate::view::Viewbox;

        let scale = 1.0;
        let (mut pool, plain, _gathers, _scatters) =
            build_drag_scene(n_shapes, n_gathers, n_scatters);
        let drag_id = plain[plain.len() / 2];

        let viewbox = Viewbox::new(6400.0, 6400.0);
        let tv = TileViewbox::new_with_interest(viewbox, 1, scale);

        let mut grid = TileGrid::new();
        grid.rebuild(&pool, &tv, scale);

        let frames = 100;
        let start = Instant::now();
        for f in 0..frames {
            let x = (f as f32) * 2.0;
            let s = pool.get_mut(&drag_id).unwrap();
            s.selrect = skia::Rect::from_xywh(x, 0.0, 100.0, 80.0);
            grid.rebuild(&pool, &tv, scale);
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] drag plain shape ({label}, {frames} frames): {:.3}ms/frame",
            elapsed.as_secs_f64() * 1000.0 / frames as f64
        );
    }

    #[test]
    fn bench_drag_plain_in_scene_baseline() {
        drag_plain_shape_with_effects(1_000, 0, 0, "1k plain, 0 gathers, 0 scatters");
    }

    #[test]
    fn bench_drag_plain_in_scene_5_gathers_5_scatters() {
        drag_plain_shape_with_effects(1_000, 5, 5, "1k plain, 5 gathers, 5 scatters");
    }

    #[test]
    fn bench_drag_plain_in_scene_20_gathers_20_scatters() {
        drag_plain_shape_with_effects(1_000, 20, 20, "1k plain, 20 gathers, 20 scatters");
    }

    // ── Test 2: drag a gather/scatter shape itself (cache invalidation) ─────

    fn drag_effect_shape_helper(
        n_shapes: usize,
        n_gathers: usize,
        n_scatters: usize,
        target: DragTarget,
        label: &str,
    ) {
        use crate::view::Viewbox;

        let scale = 1.0;
        let (mut pool, _plain, gathers, scatters) =
            build_drag_scene(n_shapes, n_gathers, n_scatters);

        let (drag_id, w, h) = match target {
            DragTarget::Gather => (
                *gathers.first().expect("need ≥ 1 gather"),
                1000.0_f32,
                1000.0_f32,
            ),
            DragTarget::Scatter => (
                *scatters.first().expect("need ≥ 1 scatter"),
                400.0_f32,
                400.0_f32,
            ),
        };

        let viewbox = Viewbox::new(6400.0, 6400.0);
        let tv = TileViewbox::new_with_interest(viewbox, 1, scale);

        let mut grid = TileGrid::new();
        grid.rebuild(&pool, &tv, scale);

        let frames = 100;
        let start = Instant::now();
        for f in 0..frames {
            let x = (f as f32) * 4.0;
            let s = pool.get_mut(&drag_id).unwrap();
            s.selrect = skia::Rect::from_xywh(x, 0.0, w, h);
            grid.rebuild(&pool, &tv, scale);
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] drag {target:?} shape ({label}, {frames} frames): {:.3}ms/frame",
            elapsed.as_secs_f64() * 1000.0 / frames as f64
        );
    }

    #[derive(Debug, Copy, Clone)]
    enum DragTarget {
        Gather,
        Scatter,
    }

    #[test]
    fn bench_drag_gather_alone() {
        drag_effect_shape_helper(
            1_000,
            1,
            0,
            DragTarget::Gather,
            "1k plain, 1 gather, 0 scatters",
        );
    }

    #[test]
    fn bench_drag_gather_with_peers() {
        drag_effect_shape_helper(
            1_000,
            5,
            5,
            DragTarget::Gather,
            "1k plain, 5 gathers, 5 scatters",
        );
    }

    #[test]
    fn bench_drag_scatter_with_peers() {
        drag_effect_shape_helper(
            1_000,
            5,
            5,
            DragTarget::Scatter,
            "1k plain, 5 gathers, 5 scatters",
        );
    }

    // ── Test 3: pan-sweep / zoom-sweep across the scene ────────────────────

    #[derive(Debug, Copy, Clone)]
    enum SweepMode {
        Pan,
        Zoom,
    }

    fn pan_zoom_sweep(
        n_shapes: usize,
        n_gathers: usize,
        n_scatters: usize,
        mode: SweepMode,
        label: &str,
    ) {
        use crate::view::Viewbox;

        let scale = 1.0;
        let (pool, _plain, _gathers, _scatters) = build_drag_scene(n_shapes, n_gathers, n_scatters);

        let mut viewbox = Viewbox::new(1920.0, 1080.0);
        viewbox.set_all(1.0, 0.0, 0.0);

        let tv_warm = TileViewbox::new_with_interest(viewbox, 1, scale);
        let mut grid = TileGrid::new();
        grid.rebuild(&pool, &tv_warm, scale);

        let frames = 100;
        let start = Instant::now();
        for f in 0..frames {
            match mode {
                SweepMode::Pan => {
                    // Sweep right across the 100×N grid (60px stride per frame).
                    let pan_x = -(f as f32) * 60.0;
                    viewbox.set_all(1.0, pan_x, 0.0);
                }
                SweepMode::Zoom => {
                    // Geometric zoom from 0.25× to 4× across `frames` steps.
                    let t = f as f32 / (frames - 1).max(1) as f32;
                    let zoom = 0.25 * (16.0_f32).powf(t);
                    viewbox.set_all(zoom, 0.0, 0.0);
                }
            }
            let tv = TileViewbox::new_with_interest(viewbox, 1, scale);
            grid.rebuild(&pool, &tv, scale);
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] {mode:?}-sweep ({label}, {frames} frames): {:.3}ms/frame",
            elapsed.as_secs_f64() * 1000.0 / frames as f64
        );
    }

    #[test]
    fn bench_pan_sweep_baseline() {
        pan_zoom_sweep(
            1_000,
            0,
            0,
            SweepMode::Pan,
            "1k plain, 0 gathers, 0 scatters",
        );
    }

    #[test]
    fn bench_pan_sweep_with_effects() {
        pan_zoom_sweep(
            1_000,
            5,
            5,
            SweepMode::Pan,
            "1k plain, 5 gathers, 5 scatters",
        );
    }

    #[test]
    fn bench_zoom_sweep_baseline() {
        pan_zoom_sweep(
            1_000,
            0,
            0,
            SweepMode::Zoom,
            "1k plain, 0 gathers, 0 scatters",
        );
    }

    #[test]
    fn bench_zoom_sweep_with_effects() {
        pan_zoom_sweep(
            1_000,
            5,
            5,
            SweepMode::Zoom,
            "1k plain, 5 gathers, 5 scatters",
        );
    }

    // ── 10k-shape variants of the interaction benches ──────────────────────

    #[test]
    fn bench_drag_plain_in_scene_10k_baseline() {
        drag_plain_shape_with_effects(10_000, 0, 0, "10k plain, 0 gathers, 0 scatters");
    }

    #[test]
    fn bench_drag_plain_in_scene_10k_5_gathers_5_scatters() {
        drag_plain_shape_with_effects(10_000, 5, 5, "10k plain, 5 gathers, 5 scatters");
    }

    #[test]
    fn bench_drag_plain_in_scene_10k_20_gathers_20_scatters() {
        drag_plain_shape_with_effects(10_000, 20, 20, "10k plain, 20 gathers, 20 scatters");
    }

    #[test]
    fn bench_drag_gather_with_peers_10k() {
        drag_effect_shape_helper(
            10_000,
            5,
            5,
            DragTarget::Gather,
            "10k plain, 5 gathers, 5 scatters",
        );
    }

    #[test]
    fn bench_drag_scatter_with_peers_10k() {
        drag_effect_shape_helper(
            10_000,
            5,
            5,
            DragTarget::Scatter,
            "10k plain, 5 gathers, 5 scatters",
        );
    }

    #[test]
    fn bench_pan_sweep_10k_baseline() {
        pan_zoom_sweep(
            10_000,
            0,
            0,
            SweepMode::Pan,
            "10k plain, 0 gathers, 0 scatters",
        );
    }

    #[test]
    fn bench_pan_sweep_10k_with_effects() {
        pan_zoom_sweep(
            10_000,
            5,
            5,
            SweepMode::Pan,
            "10k plain, 5 gathers, 5 scatters",
        );
    }

    #[test]
    fn bench_zoom_sweep_10k_baseline() {
        pan_zoom_sweep(
            10_000,
            0,
            0,
            SweepMode::Zoom,
            "10k plain, 0 gathers, 0 scatters",
        );
    }

    #[test]
    fn bench_zoom_sweep_10k_with_effects() {
        pan_zoom_sweep(
            10_000,
            5,
            5,
            SweepMode::Zoom,
            "10k plain, 5 gathers, 5 scatters",
        );
    }

    // ── Incremental drag benches: `update_touched` instead of full `rebuild`
    //
    // Same scenes as the `drag_plain_*` / `drag_*_with_peers*` benches above,
    // but the per-frame schedule update goes through `update_touched(&{id})`
    // — the path production already uses via `rebuild_touched_tiles` ([
    // tile_grid.rs:2445]). This isolates the incremental indexing win.
    // Bands/deps/topo/schedule are still rebuilt fully inside `update_touched`,
    // so the win is bounded to skipping the full shape-tree walk in `rebuild`'s
    // Step 1.

    fn drag_plain_shape_incremental(
        n_shapes: usize,
        n_gathers: usize,
        n_scatters: usize,
        label: &str,
    ) {
        use crate::view::Viewbox;

        let scale = 1.0;
        let (mut pool, plain, _gathers, _scatters) =
            build_drag_scene(n_shapes, n_gathers, n_scatters);
        let drag_id = plain[plain.len() / 2];

        let viewbox = Viewbox::new(6400.0, 6400.0);
        let tv = TileViewbox::new_with_interest(viewbox, 1, scale);

        let mut grid = TileGrid::new();
        // Initial full build — incremental update assumes a primed grid.
        grid.rebuild(&pool, &tv, scale);

        let mut touched: HashSet<Uuid> = HashSet::with_capacity_and_hasher(1, Default::default());

        let frames = 100;
        let start = Instant::now();
        for f in 0..frames {
            let x = (f as f32) * 2.0;
            let s = pool.get_mut(&drag_id).unwrap();
            s.selrect = skia::Rect::from_xywh(x, 0.0, 100.0, 80.0);

            touched.clear();
            touched.insert(drag_id);
            let _ = grid.update_touched(&touched, &pool, &tv, scale);
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] drag plain incremental ({label}, {frames} frames): {:.3}ms/frame",
            elapsed.as_secs_f64() * 1000.0 / frames as f64
        );
    }

    fn drag_effect_shape_incremental(
        n_shapes: usize,
        n_gathers: usize,
        n_scatters: usize,
        target: DragTarget,
        label: &str,
    ) {
        use crate::view::Viewbox;

        let scale = 1.0;
        let (mut pool, _plain, gathers, scatters) =
            build_drag_scene(n_shapes, n_gathers, n_scatters);

        let (drag_id, w, h) = match target {
            DragTarget::Gather => (
                *gathers.first().expect("need ≥ 1 gather"),
                1000.0_f32,
                1000.0_f32,
            ),
            DragTarget::Scatter => (
                *scatters.first().expect("need ≥ 1 scatter"),
                400.0_f32,
                400.0_f32,
            ),
        };

        let viewbox = Viewbox::new(6400.0, 6400.0);
        let tv = TileViewbox::new_with_interest(viewbox, 1, scale);

        let mut grid = TileGrid::new();
        grid.rebuild(&pool, &tv, scale);

        let mut touched: HashSet<Uuid> = HashSet::with_capacity_and_hasher(1, Default::default());

        let frames = 100;
        let start = Instant::now();
        for f in 0..frames {
            let x = (f as f32) * 4.0;
            let s = pool.get_mut(&drag_id).unwrap();
            s.selrect = skia::Rect::from_xywh(x, 0.0, w, h);

            touched.clear();
            touched.insert(drag_id);
            let _ = grid.update_touched(&touched, &pool, &tv, scale);
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] drag {target:?} incremental ({label}, {frames} frames): {:.3}ms/frame",
            elapsed.as_secs_f64() * 1000.0 / frames as f64
        );
    }

    // 1k incremental drag variants
    #[test]
    fn bench_drag_plain_incremental_baseline() {
        drag_plain_shape_incremental(1_000, 0, 0, "1k plain, 0 gathers, 0 scatters");
    }

    #[test]
    fn bench_drag_plain_incremental_5_gathers_5_scatters() {
        drag_plain_shape_incremental(1_000, 5, 5, "1k plain, 5 gathers, 5 scatters");
    }

    #[test]
    fn bench_drag_plain_incremental_20_gathers_20_scatters() {
        drag_plain_shape_incremental(1_000, 20, 20, "1k plain, 20 gathers, 20 scatters");
    }

    #[test]
    fn bench_drag_gather_incremental_with_peers() {
        drag_effect_shape_incremental(
            1_000,
            5,
            5,
            DragTarget::Gather,
            "1k plain, 5 gathers, 5 scatters",
        );
    }

    #[test]
    fn bench_drag_scatter_incremental_with_peers() {
        drag_effect_shape_incremental(
            1_000,
            5,
            5,
            DragTarget::Scatter,
            "1k plain, 5 gathers, 5 scatters",
        );
    }

    // 10k incremental drag variants
    #[test]
    fn bench_drag_plain_incremental_10k_baseline() {
        drag_plain_shape_incremental(10_000, 0, 0, "10k plain, 0 gathers, 0 scatters");
    }

    #[test]
    fn bench_drag_plain_incremental_10k_5_gathers_5_scatters() {
        drag_plain_shape_incremental(10_000, 5, 5, "10k plain, 5 gathers, 5 scatters");
    }

    #[test]
    fn bench_drag_plain_incremental_10k_20_gathers_20_scatters() {
        drag_plain_shape_incremental(10_000, 20, 20, "10k plain, 20 gathers, 20 scatters");
    }

    #[test]
    fn bench_drag_gather_incremental_with_peers_10k() {
        drag_effect_shape_incremental(
            10_000,
            5,
            5,
            DragTarget::Gather,
            "10k plain, 5 gathers, 5 scatters",
        );
    }

    #[test]
    fn bench_drag_scatter_incremental_with_peers_10k() {
        drag_effect_shape_incremental(
            10_000,
            5,
            5,
            DragTarget::Scatter,
            "10k plain, 5 gathers, 5 scatters",
        );
    }

    // ── Drag with REALISTIC 1920×1080 viewport ─────────────────────────────
    //
    // The drag_plain_* benches above use a 6400×6400 viewbox so the interest
    // rect covers every shape in the test scene. That makes Step 3-6 of
    // `rebuild` (compute_bands, build_dep_graph, topo_sort, build_schedule)
    // walk ~14k entries. In that regime, skipping Step 1's full shape walk
    // (the only thing `update_touched` does differently from `rebuild`) is a
    // small fraction of the total cost.
    //
    // Production drag uses a real browser viewport (~1920×1080). Then
    // Step 1 still walks all N shapes (extrect + intersect), but only the
    // ~visible-set lands in `self.grid`, so Step 3-6 are cheap. Step 1
    // becomes the dominant cost — and that's exactly what `update_touched`
    // skips. These benches measure that scenario.

    fn drag_plain_realistic_viewport(
        n_shapes: usize,
        n_gathers: usize,
        n_scatters: usize,
        use_incremental: bool,
        label: &str,
    ) {
        use crate::view::Viewbox;

        let scale = 1.0;
        let (mut pool, plain, _gathers, _scatters) =
            build_drag_scene(n_shapes, n_gathers, n_scatters);
        let drag_id = plain[plain.len() / 2];

        // Realistic browser viewport — small interest rect, only ~visible-set
        // shapes end up in the grid.
        let viewbox = Viewbox::new(1920.0, 1080.0);
        let tv = TileViewbox::new_with_interest(viewbox, 1, scale);

        let mut grid = TileGrid::new();
        grid.rebuild(&pool, &tv, scale);

        let mut touched: HashSet<Uuid> = HashSet::with_capacity_and_hasher(1, Default::default());

        let frames = 100;
        let start = Instant::now();
        for f in 0..frames {
            let x = (f as f32) * 2.0;
            let s = pool.get_mut(&drag_id).unwrap();
            s.selrect = skia::Rect::from_xywh(x, 0.0, 100.0, 80.0);

            if use_incremental {
                touched.clear();
                touched.insert(drag_id);
                let _ = grid.update_touched(&touched, &pool, &tv, scale);
            } else {
                grid.rebuild(&pool, &tv, scale);
            }
        }
        let elapsed = start.elapsed();
        let mode = if use_incremental { "incremental" } else { "rebuild" };
        println!(
            "[bench] drag plain realistic-viewport {mode} ({label}, {frames} frames): {:.3}ms/frame",
            elapsed.as_secs_f64() * 1000.0 / frames as f64
        );
    }

    #[test]
    fn bench_drag_plain_realistic_rebuild_10k_baseline() {
        drag_plain_realistic_viewport(10_000, 0, 0, false, "10k plain, 0G, 0S");
    }

    #[test]
    fn bench_drag_plain_realistic_incremental_10k_baseline() {
        drag_plain_realistic_viewport(10_000, 0, 0, true, "10k plain, 0G, 0S");
    }

    #[test]
    fn bench_drag_plain_realistic_rebuild_10k_with_effects() {
        drag_plain_realistic_viewport(10_000, 5, 5, false, "10k plain, 5G, 5S");
    }

    #[test]
    fn bench_drag_plain_realistic_incremental_10k_with_effects() {
        drag_plain_realistic_viewport(10_000, 5, 5, true, "10k plain, 5G, 5S");
    }

    #[test]
    fn bench_drag_plain_realistic_rebuild_1k_baseline() {
        drag_plain_realistic_viewport(1_000, 0, 0, false, "1k plain, 0G, 0S");
    }

    #[test]
    fn bench_drag_plain_realistic_incremental_1k_baseline() {
        drag_plain_realistic_viewport(1_000, 0, 0, true, "1k plain, 0G, 0S");
    }
}

// ── Correctness tests for paint_order + dep-graph scheduling ────────────

#[cfg(test)]
mod scheduling_tests {
    use super::super::*;
    use crate::shapes::GlassEffect;
    use crate::state::ShapesPool;
    use crate::view::Viewbox;

    fn uid(n: u64) -> Uuid {
        Uuid::from_u64_pair(0, n)
    }

    /// Build a minimal pool with a root (Uuid::nil()) in place.
    fn new_pool() -> ShapesPool {
        let mut pool = ShapesPool::new();
        pool.add_shape(Uuid::nil());
        pool
    }

    /// Add a shape to the pool as a child of `parent_id` with the given
    /// selrect. Appends `id` to the parent's `children` vec, respecting
    /// bottom-first paint order.
    fn add_leaf(pool: &mut ShapesPool, id: Uuid, parent_id: Uuid, rect: skia::Rect) {
        let shape = pool.add_shape(id);
        shape.id = id;
        shape.parent_id = Some(parent_id);
        shape.selrect = rect;

        let parent = pool.get_mut(&parent_id).expect("parent must exist");
        parent.children.push(id);
    }

    /// As `add_leaf` but also attaches a default non-hidden `GlassEffect`.
    fn add_glass(pool: &mut ShapesPool, id: Uuid, parent_id: Uuid, rect: skia::Rect) {
        add_leaf(pool, id, parent_id, rect);
        let s = pool.get_mut(&id).unwrap();
        s.glass = Some(GlassEffect {
            surface_type: 0,
            bezel_width: 10.0,
            glass_thickness: 1.0,
            refractive_index: 1.0,
            specular_angle: 0.0,
            specular_opacity: 0.0,
            specular_saturation: 0.0,
            chromatic_aberration: 0.0,
            splay: 0.0,
            tilt_angle: 0.0,
            edge_boost: 0.0,
            zoom: 1.0,
            blur: 50.0,
            frost: 0.0,
            hidden: false,
        });
    }

    fn make_tile_viewbox(scale: f32) -> TileViewbox {
        let viewbox = Viewbox::new(1920.0, 1080.0);
        TileViewbox::new_with_interest(viewbox, 1, scale)
    }

    /// Find the first ShapeEntry for `id` anywhere in the grid.
    fn entry_for<'a>(grid: &'a TileGrid, id: Uuid) -> Option<&'a ShapeEntry> {
        for entries in grid.grid.values() {
            for e in entries {
                if e.id == id {
                    return Some(e);
                }
            }
        }
        None
    }

    /// Position of the first `SetTileBand` step targeting `tile` in the flat
    /// schedule.
    fn set_tile_pos(schedule: &[RenderStep], tile: Tile) -> Option<usize> {
        schedule.iter().position(|s| matches!(s, RenderStep::SetTileBand { tile: t, .. } if *t == tile))
    }

    // ── paint_order assignment ───────────────────────────────────────

    #[test]
    fn paint_order_is_depth_first_bottom_first() {
        // Tree: root → [leaf_a, container → [child_x, child_y], leaf_b]
        // Paint order: leaf_a (0) → container (1) → child_x (2) → child_y (3) → leaf_b (4)
        let scale = 1.0;
        let mut pool = new_pool();
        let leaf_a = uid(10);
        let container = uid(20);
        let child_x = uid(21);
        let child_y = uid(22);
        let leaf_b = uid(30);

        add_leaf(&mut pool, leaf_a, Uuid::nil(), skia::Rect::from_xywh(100.0, 100.0, 100.0, 100.0));
        add_leaf(&mut pool, container, Uuid::nil(), skia::Rect::from_xywh(300.0, 100.0, 300.0, 300.0));
        // Mark container as a Group so it's recursive.
        {
            let c = pool.get_mut(&container).unwrap();
            c.shape_type = crate::shapes::Type::Group(crate::shapes::Group { masked: false });
        }
        add_leaf(&mut pool, child_x, container, skia::Rect::from_xywh(300.0, 100.0, 100.0, 100.0));
        add_leaf(&mut pool, child_y, container, skia::Rect::from_xywh(450.0, 100.0, 100.0, 100.0));
        add_leaf(&mut pool, leaf_b, Uuid::nil(), skia::Rect::from_xywh(700.0, 100.0, 100.0, 100.0));

        let mut grid = TileGrid::new();
        let tv = make_tile_viewbox(scale);
        grid.rebuild(&pool, &tv, scale);

        let po = |id: Uuid| entry_for(&grid, id).map(|e| e.paint_order).unwrap_or(u32::MAX);

        let po_a = po(leaf_a);
        let po_ctr = po(container);
        let po_x = po(child_x);
        let po_y = po(child_y);
        let po_b = po(leaf_b);

        assert_eq!(po_a, 0, "leaf_a is painted first");
        assert!(po_ctr > po_a && po_ctr < po_x, "container sits between leaf_a and its children (got {po_ctr})");
        assert!(po_x < po_y, "child_x painted before child_y (got {po_x} vs {po_y})");
        assert!(po_b > po_y, "leaf_b painted after container's children");
    }

    // ── Band model + band-aware scheduling ─────────────────────────

    /// Count `SetTileBand` steps for a specific tile in the flat schedule.
    fn band_steps_for(schedule: &[RenderStep], tile: Tile) -> Vec<(u32, bool, bool)> {
        schedule
            .iter()
            .filter_map(|s| match s {
                RenderStep::SetTileBand {
                    tile: t,
                    band_index,
                    is_first,
                    is_last,
                } if *t == tile => Some((*band_index, *is_first, *is_last)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn bands_far_tile_not_split_by_distant_gather() {
        // Locality check: a gather near the origin must NOT force tiles far
        // from it (outside its sample region) into multiple bands.
        let scale = 1.0;
        let mut pool = new_pool();
        let glass = uid(1);
        let far = uid(2);
        // Small glass around origin — sample region stays close.
        add_glass(&mut pool, glass, Uuid::nil(), skia::Rect::from_xywh(50.0, 50.0, 100.0, 100.0));
        // Shape far outside glass's sample region. Tile ~ (15, 15) at scale 1
        // (tile size ≈ 512).
        add_leaf(&mut pool, far, Uuid::nil(), skia::Rect::from_xywh(7800.0, 7800.0, 100.0, 100.0));

        let mut grid = TileGrid::new();
        // Custom viewbox wide enough to include the far shape.
        let viewbox = crate::view::Viewbox::new(16384.0, 16384.0);
        let tv = TileViewbox::new_with_interest(viewbox, 1, scale);
        grid.rebuild(&pool, &tv, scale);

        let far_tiles: Vec<Tile> = grid.index.get(&far).unwrap().iter().copied().collect();
        assert!(!far_tiles.is_empty(), "far shape must be indexed");
        for t in &far_tiles {
            let bands = grid.bands.get(t).expect("tile must have bands");
            assert_eq!(
                bands.len(),
                1,
                "far tile {:?} must not be split by distant gather; got {} bands",
                t,
                bands.len()
            );
        }
    }

    #[test]
    fn peer_glass_regression_no_tile_dropped() {
        // Primary regression for the original bug: a single glass shape
        // spans multiple tiles with a below-shape in all of them. Under the
        // old tile-atomic scheduler this produced a cycle; Kahn dropped the
        // cycle-bound tiles silently. Under the band model it must resolve
        // to a strict DAG with every BandKey present in the final schedule.
        let scale = 1.0;
        let mut pool = new_pool();
        let backdrop = uid(1);
        let glass = uid(2);
        // Backdrop spans roughly the same tiles as glass so both sit in
        // each tile.
        add_leaf(
            &mut pool,
            backdrop,
            Uuid::nil(),
            skia::Rect::from_xywh(200.0, 200.0, 1400.0, 1400.0),
        );
        // Glass covering tiles (0,0)..(2,2) at scale 1.
        add_glass(
            &mut pool,
            glass,
            Uuid::nil(),
            skia::Rect::from_xywh(200.0, 200.0, 1400.0, 1400.0),
        );

        let mut grid = TileGrid::new();
        let tv = make_tile_viewbox(scale);
        grid.rebuild(&pool, &tv, scale);

        // Every tile that contains the glass shape must emit ≥ 1 band that
        // has the gather at its head. More importantly, no glass-tile may
        // be missing from the schedule.
        let glass_tiles: Vec<Tile> = grid.index.get(&glass).unwrap().iter().copied().collect();
        assert!(!glass_tiles.is_empty());
        for gt in &glass_tiles {
            let steps = band_steps_for(&grid.schedule, *gt);
            assert!(
                !steps.is_empty(),
                "glass tile {:?} must appear in the schedule (would be missing under old scheduler): \
                 schedule_len={} bands_for_tile={:?}",
                gt,
                grid.schedule.len(),
                grid.bands.get(gt)
            );
            // A glass tile always has ≥ 2 bands (below + gather-at-head).
            assert!(
                steps.len() >= 2,
                "glass tile {:?} must have ≥ 2 bands; got {:?}",
                gt,
                steps
            );
        }
    }

    #[test]
    fn schedule_is_complete_every_band_scheduled_exactly_once() {
        // Every BandKey produced by `compute_bands` must appear in the
        // schedule exactly once (no duplicates, no drops). The schedule may
        // ALSO contain synthetic empty-tile SetTileBands for spiral tiles
        // that have no shapes — those are needed to clear Target at those
        // tile rects so previous-frame pixels don't linger.
        let scale = 1.0;
        let mut pool = new_pool();
        let backdrop = uid(1);
        let glass = uid(2);
        add_leaf(&mut pool, backdrop, Uuid::nil(), skia::Rect::from_xywh(100.0, 100.0, 100.0, 100.0));
        add_glass(&mut pool, glass, Uuid::nil(), skia::Rect::from_xywh(600.0, 600.0, 500.0, 500.0));

        let mut grid = TileGrid::new();
        let tv = make_tile_viewbox(scale);
        grid.rebuild(&pool, &tv, scale);

        let mut expected: HashSet<BandKey> = HashSet::default();
        for (tile, bands) in &grid.bands {
            for idx in 0..bands.len() {
                expected.insert(BandKey::new(*tile, idx as u32));
            }
        }

        let mut got: HashSet<BandKey> = HashSet::default();
        for step in &grid.schedule {
            if let RenderStep::SetTileBand { tile, band_index, .. } = step {
                let key = BandKey::new(*tile, *band_index);
                assert!(got.insert(key), "duplicate SetTileBand for {:?}", key);
            }
        }
        for key in &expected {
            assert!(
                got.contains(key),
                "schedule missing required BandKey {:?}",
                key
            );
        }
    }

    #[test]
    fn gather_band_depends_on_below_shape_in_different_tile() {
        // A below-shape sits in a tile NOT containing the gather itself. The
        // gather's sample region reaches into the below-shape's tile. The
        // schedule must ensure the below-shape tile's band 0 runs BEFORE any
        // gather band that samples it, so Target has the below content when
        // the gather reads its backdrop.
        let scale = 1.0;
        let mut pool = new_pool();
        let below = uid(1); // po=0 — far from the gather
        let glass = uid(2); // po=1 — gather with large sample radius

        // Below shape at tile (0,0) area.
        add_leaf(&mut pool, below, Uuid::nil(), skia::Rect::from_xywh(100.0, 100.0, 100.0, 100.0));
        // Glass at tile (1,1)-(2,2). With default glass params (blur=50,
        // thickness=1) the sample expand is large enough to include (0,0).
        add_glass(&mut pool, glass, Uuid::nil(), skia::Rect::from_xywh(600.0, 600.0, 500.0, 500.0));

        let mut grid = TileGrid::new();
        let tv = make_tile_viewbox(scale);
        grid.rebuild(&pool, &tv, scale);

        let below_tile = Tile::from(0, 0);
        let below_pos = set_tile_pos(&grid.schedule, below_tile)
            .expect("below tile (0,0) must appear in the schedule");

        // For every glass tile, locate its gather-head SetTileBand and
        // assert it comes after below_tile's SetTileBand.
        let glass_tiles: Vec<Tile> = grid.index.get(&glass).unwrap().iter().copied().collect();
        for gt in &glass_tiles {
            // Find the gather band (the one whose gather_at_head matches).
            let bands = grid.bands.get(gt).expect("glass tile has bands");
            let gather_band_idx = bands
                .iter()
                .position(|b| b.gather_at_head == Some(glass))
                .expect("glass tile must have a gather-head band");
            let gather_step_pos = grid
                .schedule
                .iter()
                .position(|s| {
                    matches!(
                        s,
                        RenderStep::SetTileBand { tile: t, band_index, .. }
                            if *t == *gt && *band_index == gather_band_idx as u32
                    )
                })
                .expect("gather band must be in schedule");
            assert!(
                below_pos < gather_step_pos,
                "below tile (0,0) [pos {}] must come before glass tile {:?} gather band [pos {}]",
                below_pos, gt, gather_step_pos
            );
        }
    }

    #[test]
    fn non_gather_tile_in_sample_region_split_by_barrier() {
        // A tile that contains NO gather but IS in another gather's sample
        // region must still split at the gather's paint_order, so
        // above-gather shapes don't leak into the gather's backdrop sample.
        let scale = 1.0;
        let mut pool = new_pool();
        let below = uid(1); // po=0
        let glass = uid(2); // po=1
        let above = uid(3); // po=2

        // `below` inside tile (0,0).
        add_leaf(&mut pool, below, Uuid::nil(), skia::Rect::from_xywh(50.0, 50.0, 100.0, 100.0));
        // `glass` with sample region large enough to include (0,0).
        add_glass(&mut pool, glass, Uuid::nil(), skia::Rect::from_xywh(600.0, 600.0, 500.0, 500.0));
        // `above` in tile (0,0), ABOVE glass in paint order.
        add_leaf(&mut pool, above, Uuid::nil(), skia::Rect::from_xywh(160.0, 50.0, 100.0, 100.0));

        let mut grid = TileGrid::new();
        let tv = make_tile_viewbox(scale);
        grid.rebuild(&pool, &tv, scale);

        let tile_00 = Tile::from(0, 0);
        let bands = grid.bands.get(&tile_00).expect("tile (0,0) has shapes");

        // Tile (0,0) has no gather of its own, so we should only see a
        // barrier split IF (0,0) is in glass's sample region. It is (glass
        // with blur=50 + thickness=1 has a large sample expand that reaches
        // (0,0)), so expect exactly 2 bands: [below], [above].
        assert_eq!(
            bands.len(),
            2,
            "tile (0,0) must be split into 2 bands by glass's barrier; got {}: {:?}",
            bands.len(),
            bands
        );

        let po_below = entry_for(&grid, below).unwrap().paint_order;
        let po_above = entry_for(&grid, above).unwrap().paint_order;
        assert!(bands[0].shapes.contains(&below));
        assert!(bands[1].shapes.contains(&above));
        assert!(bands[0].max_paint_order == po_below);
        assert!(bands[1].min_paint_order == po_above);

        // Glass's band deps must include (0,0)'s band 0 but NOT band 1.
        let tile_size = tiles::get_tile_size(scale);
        let deps = grid.build_dependency_graph(&pool, tile_size, &tv.interest_rect, scale);

        let any_on_00_band0 = deps.iter().any(|(_, ds)| {
            ds.iter().any(|d| d.tile == tile_00 && d.band_index == 0)
        });
        let any_on_00_band1 = deps.iter().any(|(_, ds)| {
            ds.iter().any(|d| d.tile == tile_00 && d.band_index == 1)
        });
        assert!(any_on_00_band0, "some band must depend on (0,0)/0 (below-glass)");
        assert!(!any_on_00_band1, "no band may depend on (0,0)/1 (above-glass leak!)");
    }
}
