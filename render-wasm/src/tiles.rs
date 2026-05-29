use crate::view::Viewbox;
use skia_safe as skia;
#[derive(PartialEq, Eq, Hash, Clone, Copy, Debug)]
pub struct Tile(pub i32, pub i32);

impl Tile {
    pub fn from(x: i32, y: i32) -> Self {
        Tile(x, y)
    }
    pub fn x(&self) -> i32 {
        self.0
    }
    pub fn y(&self) -> i32 {
        self.1
    }
}

#[derive(PartialEq, Eq, Hash, Clone, Copy, Debug)]
pub struct TileRect(pub i32, pub i32, pub i32, pub i32);

impl TileRect {
    pub fn x1(&self) -> i32 {
        self.0
    }

    pub fn y1(&self) -> i32 {
        self.1
    }

    pub fn x2(&self) -> i32 {
        self.2
    }

    pub fn y2(&self) -> i32 {
        self.3
    }

    pub fn width(&self) -> i32 {
        self.x2() - self.x1()
    }

    pub fn height(&self) -> i32 {
        self.y2() - self.y1()
    }

    pub fn center_x(&self) -> i32 {
        self.x1() + self.width() / 2
    }

    pub fn center_y(&self) -> i32 {
        self.y1() + self.height() / 2
    }

    pub fn contains(&self, tile: &Tile) -> bool {
        tile.x() >= self.x1()
            && tile.y() >= self.y1()
            && tile.x() <= self.x2()
            && tile.y() <= self.y2()
    }
}

#[derive(Debug)]
pub struct TileViewbox {
    pub visible_rect: TileRect,
    pub interest_rect: TileRect,
    pub interest: i32,
    pub center: Tile,
}

impl TileViewbox {
    pub fn new_with_interest(viewbox: Viewbox, interest: i32, scale: f32) -> Self {
        Self {
            visible_rect: get_tiles_for_viewbox(viewbox, scale),
            interest_rect: get_tiles_for_viewbox_with_interest(viewbox, interest, scale),
            interest,
            center: get_tile_center_for_viewbox(viewbox, scale),
        }
    }

    pub fn update(&mut self, viewbox: Viewbox, scale: f32) {
        self.visible_rect = get_tiles_for_viewbox(viewbox, scale);
        self.interest_rect = get_tiles_for_viewbox_with_interest(viewbox, self.interest, scale);
        self.center = get_tile_center_for_viewbox(viewbox, scale);
    }

    pub fn is_visible(&self, tile: &Tile) -> bool {
        // TO CHECK self.interest_rect.contains(tile)
        self.visible_rect.contains(tile)
    }
}

pub const TILE_SIZE: f32 = 512.;

pub fn get_tile_dimensions() -> skia::ISize {
    (TILE_SIZE as i32, TILE_SIZE as i32).into()
}

pub fn get_tiles_for_rect(rect: skia::Rect, tile_size: f32) -> TileRect {
    // start
    let sx = (rect.left / tile_size).floor() as i32;
    let sy = (rect.top / tile_size).floor() as i32;
    // end
    let ex = (rect.right / tile_size).floor() as i32;
    let ey = (rect.bottom / tile_size).floor() as i32;
    TileRect(sx, sy, ex, ey)
}

pub fn get_tiles_for_viewbox(viewbox: Viewbox, scale: f32) -> TileRect {
    let tile_size = get_tile_size(scale);
    get_tiles_for_rect(viewbox.area, tile_size)
}

pub fn get_tiles_for_viewbox_with_interest(
    viewbox: Viewbox,
    interest: i32,
    scale: f32,
) -> TileRect {
    let TileRect(sx, sy, ex, ey) = get_tiles_for_viewbox(viewbox, scale);
    TileRect(sx - interest, sy - interest, ex + interest, ey + interest)
}

pub fn get_tile_center_for_viewbox(viewbox: Viewbox, scale: f32) -> Tile {
    let TileRect(sx, sy, ex, ey) = get_tiles_for_viewbox(viewbox, scale);
    Tile((ex - sx) / 2, (ey - sy) / 2)
}

pub fn get_tile_pos(Tile(x, y): Tile, scale: f32) -> (f32, f32) {
    (
        x as f32 * get_tile_size(scale),
        y as f32 * get_tile_size(scale),
    )
}

pub fn get_tile_size(scale: f32) -> f32 {
    1. / scale * TILE_SIZE
}

// `TileHashMap` and `PendingTiles` lived here for the V1 renderer's
// per-tile spatial index + spiral-priority queue. V1 was deleted in
// Phase A of the legacy-deletion plan; V2 (and SSA, which reuses V2's
// `tile_grid::TileGrid`) carry the same responsibilities natively. The
// associated `#[cfg(test)] mod bench` block was removed with them.
