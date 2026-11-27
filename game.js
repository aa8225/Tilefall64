/*
 * TILEFALL 64 - game code
 * (c) 2026 AA Software Ltd. All rights reserved.
 *
 * An 8-bit tile-catching arcade game. Catch tiles on the paddle, drop them
 * into the bin and line up three or more of a colour to clear them.
 *
 * Everything is drawn on a tiny 180 x 320 pixel canvas that is scaled up to
 * fill the screen, and all music and sound is synthesised live in the browser.
 * There are no image or sound files for the game itself.
 *
 * Contents:
 *   1. Screen geometry and colours
 *   2. Saved data and game state
 *   3. Drawing helpers
 *   4. Pixel-art scenes
 *   5. Sound and music
 *   6. Game rules
 *   7. Drawing each frame
 *   8. Controls, sharing and screen layout
 *
 * The whole file sits inside one { } block so none of its names clash with
 * anything else on the page.
 */
{

    // ======================================================================
    // 1. SCREEN GEOMETRY AND COLOURS
    // The game is drawn on a tiny 180 x 320 pixel canvas, then scaled up
    // to fill the screen. All positions below are in those game pixels.
    // ======================================================================
  const W = 180, // canvas width
    H = 320, // canvas height
    RT = 34, // top of the conveyor ramp
    RB = 176, // bottom of the ramp, where tiles reach the paddle
    STEPS = 10, // tumbles a tile takes to travel down the ramp
    PY = 186, // paddle height on screen
    BY = 200, // top of the bin
    CH = 22; // height of one bin row

  // The visible game canvas and its drawing context.
  const cv = document.getElementById("c"),
    ctx = cv.getContext("2d");

  // Off-screen canvas holding the current scene, painted once per wave.
  const bgc = document.createElement("canvas");
  bgc.width = W;
  bgc.height = H;
  const g = bgc.getContext("2d");

  // Tile colours: red, blue, green, yellow, purple, orange, white.
  // (Colour number 7 is used for the flashing wild tile.)
  const COLS = ["#e8403c", "#3c8cff", "#3ad35a", "#ffd23a", "#c45cff", "#ff8a2a", "#f0f0f0"];

  // A 3x3 pixel symbol stamped on each colour, so tiles can be told apart
  // without relying on colour alone. Each 9-bit number is one symbol.
  const GLY = [0b010111010, 0b101010101, 0b111101111, 0b010101010, 0b100010001, 0b111000111, 0b000010000];

  // Convert '#rrggbb' into [red, green, blue].
  const rgb = (h) => {
    const n = parseInt(h.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  };

  // Lighten (a > 0) or darken (a < 0) a colour; returns a CSS rgb() string.
  const shade = (h, a) =>
    "rgb(" +
    rgb(h)
      .map((v) => Math.max(0, Math.min(255, Math.round(a > 0 ? v + (255 - v) * a : v * (1 + a)))))
      .join(",") +
    ")";

  // Ready-made shades for every tile colour: base, highlight, shadow, edge.
  const PAL = COLS.map((b, i) => ({
    b,
    hi: shade(b, 0.45),
    lo: shade(b, -0.45),
    dk: shade(b, -0.7),
    g: GLY[i],
  }));

    // ======================================================================
    // 2. SAVED DATA AND GAME STATE
    // Scores and settings are stored on the player's own device only
    // (localStorage). Every read is wrapped in try/catch because storage
    // can be switched off or unavailable.
    // ======================================================================

  // Best score ever (also checks the key used by the very first version).
  let hi = 0;
  try {
    hi = +localStorage.getItem("tt_hi") || 0;
  } catch (e) {}

  // Top-10 high score table and the last initials entered, cleaned up in
  // case the saved data was edited or damaged.
  let table = [],
    lastName = "AAA";
  try {
    const v = JSON.parse(localStorage.getItem("tf_scores") || "[]");
    if (Array.isArray(v))
      table = v
        .filter((e) => e && typeof e.n === "string" && typeof e.s === "number")
        .map((e) => ({
          n: e.n
            .replace(/[^A-Z0-9 ]/g, "")
            .slice(0, 3)
            .padEnd(3, " "),
          s: e.s | 0,
          w: e.w | 0,
        }))
        .slice(0, 10);
    lastName = (localStorage.getItem("tf_name") || "AAA")
      .replace(/[^A-Z]/g, "")
      .padEnd(3, "A")
      .slice(0, 3);
  } catch (e) {}
  if (table.length) hi = Math.max(hi, table[0].s);

  // Does a score earn a place in the top 10?
  const qualifies = (sc) => sc > 0 && (table.length < 10 || sc > table[table.length - 1].s);

  // Letters available when entering initials.
  const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  // Music on/off preference, remembered between visits.
  let musicOn = true;
  try {
    musicOn = localStorage.getItem("tt_mus") !== "0";
  } catch (e) {}

  // S holds the entire live state of the game.
  // S.state is the current screen: boot, title, intro, play, clear (wave
  // complete), over (game over), entry (typing initials) or pause.
  const S = {
    state: "boot", // which screen is showing
    level: 1, // current wave number
    score: 0,
    goal: 3, // target for this wave (lines, points, seconds...)
    drops: 0, // tiles missed this wave
    maxDrops: 3, // misses allowed before game over
    grid: [[], [], [], [], []], // the bin: 5 columns, colours listed bottom-up
    stack: [], // tiles held on the paddle (max 5)
    tiles: [], // tiles tumbling down the ramp
    fallers: [], // tiles dropping from the paddle into the bin
    debris: [], // missed tiles falling off screen
    fx: [], // sparkle particles
    pops: [], // floating scores and messages
    lane: 2, // paddle lane, 0-4
    px: 75, // paddle's drawn position (glides towards its lane)
    spawnT: 0, // milliseconds until the next tile
    stateT: 0, // seconds spent on the current screen
    shake: 0, // screen shake time left
    flash: 0, // red flash after a miss
    scroll: 0, // conveyor belt animation
    bgOff: 0, // scenes skipped with the SCENE button
    theme: 0, // current scene number
    parts: [], // scene particles (rain, snow, bats...)
    toast: null, // short message, e.g. a scene name
    prev: "play", // screen to return to after pausing
    bonus: 0, // end-of-wave bonus
    newHi: false, // did this game beat the best score?
  };

  // Time in milliseconds, updated every frame (drives all animation).
  let now = 0;

  // ======================================================================
  // 3. DRAWING HELPERS
  // ======================================================================
  // Draw one tile with bevelled edges. back = true shows its darker underside
  // while it tumbles. Colour 7 is the wild tile, which cycles through colours
  // and flashes a white border.
  function tile(x, y, w, h, ci, back) {
    x = Math.round(x);
    y = Math.round(y);
    w = Math.round(w);
    h = Math.max(1, Math.round(h));
    const fl = ci === 7,
      p = PAL[fl ? ((now / 90) | 0) % 7 : ci];
    ctx.fillStyle = back ? p.lo : p.b;
    ctx.fillRect(x, y, w, h);
    if (h >= 3) {
      ctx.fillStyle = back ? p.b : p.hi;
      ctx.fillRect(x, y, w, 1);
      ctx.fillRect(x, y, 1, h);
      ctx.fillStyle = p.dk;
      ctx.fillRect(x, y + h - 1, w, 1);
      ctx.fillRect(x + w - 1, y, 1, h);
    }
    if (!back && w >= 18 && h >= 10) {
      ctx.fillStyle = p.dk;
      const ox = x + Math.floor(w / 2) - 3,
        oy = y + Math.floor(h / 2) - 3;
      for (let i = 0; i < 9; i++)
        if (((fl ? 0b101010101 : p.g) >> (8 - i)) & 1)
          ctx.fillRect(ox + (i % 3) * 2, oy + Math.floor(i / 3) * 2, 2, 2);
    }
    if (fl && ((now / 110) | 0) % 2) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, Math.max(1, h - 1));
    }
  }

  // Draw text in the pixel font with a 1px drop shadow.
  function txt(s, x, y, c, a, sz) {
    sz = sz || 8;
    ctx.font = sz + 'px "Press Start 2P", monospace';
    ctx.textAlign = a || "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#000";
    ctx.fillText(s, x + 1, y + 1);
    ctx.fillStyle = c || "#fff";
    ctx.fillText(s, x, y);
  }

  // Format a score as six digits, e.g. 001250.
  const pad6 = (n) => String(n).padStart(6, "0");

  // ======================================================================
  // 4. PIXEL-ART SCENES
  // Each scene is painted once onto the off-screen canvas (g) when a wave
  // starts. The helpers below draw chunky pixels and 'dithered' gradients
  // (checkerboard blends) for an authentic 8-bit look.
  // ======================================================================
  // 4x4 ordered-dither pattern: blends gradient bands the way old
  // hardware did, with a fine checkerboard instead of smooth shading.
  const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  // Fill rows y0 to y1 with a dithered vertical gradient through the colours.
  function grad(im, stops, y0, y1) {
    const cs = stops.map(rgb),
      d = im.data;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      const f = ((y - y0) / (y1 - y0)) * (cs.length - 1),
        i = Math.min(cs.length - 2, Math.floor(f)),
        fr = Math.round((f - i) * 4) / 4;
      for (let x = 0; x < W; x++) {
        const c = fr > (BAY[(y & 3) * 4 + (x & 3)] + 0.5) / 16 ? cs[i + 1] : cs[i],
          k = (y * W + x) * 4;
        d[k] = c[0];
        d[k + 1] = c[1];
        d[k + 2] = c[2];
        d[k + 3] = 255;
      }
    }
  }

  // Filled rectangle on the scene canvas, snapped to whole pixels.
  const R = (c, x, y, w, h) => {
    g.fillStyle = c;
    g.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  };

  // Filled pixel circle on the scene canvas.
  const circ = (c, cx, cy, r) => {
    r = Math.floor(r);
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      R(c, cx - w, cy + dy, w * 2 + 1, 1);
    }
  };

  // Fill everything below the curve y = f(x): hills, dunes, sea beds.
  const ridge = (c, f) => {
    for (let x = 0; x < W; x++) {
      const y = Math.round(f(x));
      R(c, x, y, 1, H - y);
    }
  };

  // Upward-pointing triangle: mountains, pyramids, crystals, trees.
  const tri = (c, px, py, by, hw) => {
    for (let y = py; y <= by; y++) {
      const w = ((y - py) / (by - py)) * hw;
      R(c, px - w, y, w * 2 + 1, 1);
    }
  };

  // Downward-pointing triangle: icicles and stalactites.
  const triD = (c, px, ty, len, hw) => {
    for (let y = 0; y <= len; y++) {
      const w = (1 - y / len) * hw;
      R(c, px - w, ty + y, w * 2 + 1, 1);
    }
  };

  // Paint the background gradient, plus an optional second band (e.g. sea).
  const sky = (stops, y0, y1, more) => {
    const im = g.createImageData(W, H);
    grad(im, stops, y0, y1);
    if (more) grad(im, more[0], more[1], more[2]);
    g.putImageData(im, 0, 0);
  };

  // Seeded random numbers, so each scene looks the same every time.
  function rng(s) {
    return () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // TH is the list of scenes. Waves move through them in order. Each has:
  //   name    shown when the wave starts
  //   acc     accent colour for the ramp and bin edges
  //   part, n type and number of moving particles (rain, snow, bats...)
  //   th      the two-line thought shown on the wave intro
  //   draw()  paints the still picture once
  //   live()  optional: animated details drawn every frame, given the
  //           wave progress from 0 to 1
  //   calm    optional: particles thin out as the wave progresses
  const TH = [
    // Night sky, moon and mountains.
    {
      name: "STARLIGHT",
      acc: "#9a8aff",
      part: "twinkle",
      n: 26,
      draw(r) {
        sky(["#04041a", "#140f45", "#2e2170", "#4a2f86"], 0, H);
        for (let i = 0; i < 80; i++) R(["#fff", "#a8b8ff", "#ffe890"][i % 3], r() * W, r() * 240, 1, 1);
        circ("#f2eec8", 140, 52, 13);
        circ("#d4cfa0", 136, 47, 3);
        circ("#d4cfa0", 145, 57, 2);
        circ("#d4cfa0", 139, 60, 1);
        ridge("#221a52", (x) => 250 + 14 * Math.sin(x * 0.05) + 9 * Math.sin(x * 0.13 + 1));
        ridge("#0e0b2a", (x) => 280 + 10 * Math.sin(x * 0.07 + 2) + 6 * Math.sin(x * 0.21));
      },
    },
    // Sun setting over the sea, with gulls.
    {
      name: "SUNSET BAY",
      acc: "#ffb060",
      part: "none",
      n: 0,
      draw(r) {
        sky(["#2a0f4f", "#8a1f6a", "#e8505a", "#ff9a40", "#ffd870"], 0, 212, [
          ["#5a2470", "#2a1050", "#0e0626"],
          212,
          H,
        ]);
        g.save();
        g.beginPath();
        g.rect(0, 0, W, 212);
        g.clip();
        circ("#fff2a0", 90, 190, 34);
        for (const [y, h] of [
          [194, 2],
          [201, 3],
          [207, 3],
        ])
          R("#ff9a40", 50, y, 80, h);
        g.restore();
        for (let y = 216; y < 300; y += 3) {
          const w = (30 - (y - 216) * 0.3) * (0.6 + r() * 0.5);
          R("#ffd870", 90 - w + (r() - 0.5) * 6, y, w * 2, 1);
        }
        for (let i = 0; i < 5; i++) {
          const x = 20 + r() * 140,
            y = 30 + r() * 90;
          R("#2a0f4f", x, y, 2, 1);
          R("#2a0f4f", x + 2, y + 1, 1, 1);
          R("#2a0f4f", x + 3, y, 2, 1);
        }
      },
    },
    // Blue sky, clouds, rolling hills and trees.
    {
      name: "GREEN HILLS",
      acc: "#ffffff",
      part: "cloud",
      n: 3,
      draw(r) {
        sky(["#2a6ae0", "#4a9af4", "#9ad4ff"], 0, H);
        for (let i = 0; i < 5; i++) {
          const cx = r() * W,
            cy = 40 + r() * 90;
          for (let j = 0; j < 4; j++) circ("#ffffff", cx + j * 7 - 10, cy - (j % 2) * 4, 6 + r() * 3);
          R("#d8ecff", cx - 16, cy + 4, 36, 3);
        }
        ridge("#6ad860", (x) => 205 + 18 * Math.sin(x * 0.03 + 1));
        ridge("#3aa040", (x) => 235 + 14 * Math.sin(x * 0.05 + 2));
        for (let i = 0; i < 10; i++) {
          const x = r() * W,
            y = Math.round(235 + 14 * Math.sin(x * 0.05 + 2));
          tri("#14501e", x, y - 12, y, 4);
          R("#5a3a1a", x, y, 1, 2);
        }
        ridge("#1e6e2a", (x) => 270 + 10 * Math.sin(x * 0.08 + 4));
      },
    },
    // Night skyline with lit windows and falling rain.
    {
      name: "RAIN CITY",
      acc: "#60e0ff",
      part: "rain",
      n: 60,
      draw(r) {
        sky(["#08081e", "#1e1444", "#46205e", "#7a2f6a"], 0, H);
        let x = 0;
        while (x < W) {
          const w = (8 + r() * 14) | 0,
            h = (60 + r() * 100) | 0;
          R("#1e1a3c", x, H - h - 40, w, h + 40);
          x += w + 1;
        }
        x = -4;
        while (x < W) {
          const w = (12 + r() * 20) | 0,
            h = (40 + r() * 110) | 0,
            y = H - h;
          R("#0b0b18", x, y, w, h);
          if (r() < 0.3) R("#0b0b18", x + w / 2, y - 8, 1, 8);
          for (let wy = y + 4; wy < H - 4; wy += 6)
            for (let wx = x + 2; wx < x + w - 2; wx += 4)
              if (r() < 0.35) R(r() < 0.7 ? "#ffd860" : "#60e0ff", wx, wy, 2, 3);
          x += w + 2;
        }
      },
    },
    // Desert pyramids and drifting sand.
    {
      name: "DUNE SEA",
      acc: "#ffe0a0",
      part: "sand",
      n: 40,
      draw(r) {
        sky(["#e0602a", "#ff9a4a", "#ffd08a", "#fff0c0"], 0, 250);
        circ("#fff8d8", 42, 62, 16);
        for (let y = 160; y <= 245; y++) {
          const w = (y - 160) * 0.9;
          R("#e0a050", 120 - w, y, w, 1);
          R("#a86a30", 120, y, w, 1);
        }
        for (let y = 200; y <= 245; y++) {
          const w = (y - 200) * 0.9;
          R("#d89848", 52 - w, y, w, 1);
          R("#9a6028", 52, y, w, 1);
        }
        ridge("#e8b060", (x) => 238 + 6 * Math.sin(x * 0.04));
        ridge("#d09040", (x) => 262 + 10 * Math.sin(x * 0.035 + 2));
        ridge("#a86a30", (x) => 292 + 8 * Math.sin(x * 0.05 + 1));
      },
    },
    // Icicles, crystals and falling snow.
    {
      name: "ICE CAVERN",
      acc: "#c8f4ff",
      part: "snow",
      n: 50,
      draw(r) {
        sky(["#041a30", "#0a3a64", "#1a6a9a", "#5ab8d8"], 0, H);
        for (let i = 0; i < 14; i++) {
          const x = r() * W,
            len = 15 + r() * 50,
            hw = 3 + r() * 6;
          triD("#8adcf0", x, 0, len, hw);
          triD("#d8f8ff", x - hw * 0.4, 0, len * 0.7, 1);
        }
        for (let i = 0; i < 9; i++) {
          const x = r() * W,
            h = 30 + r() * 60,
            hw = 5 + r() * 8;
          tri("#3a9ad0", x, H - h, H, hw);
          tri("#c8f4ff", x - 1, H - h, H - h * 0.3, hw * 0.3);
        }
      },
    },
    // Volcano with lava streams and rising embers.
    {
      name: "MAGMA PEAK",
      acc: "#ff7a1a",
      part: "ember",
      n: 40,
      draw(r) {
        sky(["#120404", "#3a0808", "#7a1408", "#d0400c"], 0, H);
        circ("#ff5010", 90, 118, 14);
        circ("#ffb040", 90, 120, 6);
        for (let y = 120; y < H; y++) {
          const w = 12 + (y - 120) * 0.55;
          R("#2a0c0c", 90 - w, y, w * 2, 1);
          R("#3a1410", 90 - w, y, w * 0.6, 1);
        }
        for (let k = 0; k < 3; k++) {
          let x = 84 + k * 6;
          for (let y = 122; y < H; y++) {
            x += (r() - 0.5) * 2 + (k - 1) * 0.25;
            R("#ff7a1a", x, y, 2, 1);
            if (r() < 0.3) R("#ffd040", x, y, 1, 1);
          }
        }
      },
    },
    // Underwater light rays, seaweed, fish and bubbles.
    {
      name: "DEEP BLUE",
      acc: "#40d0ff",
      part: "bubble",
      n: 30,
      draw(r) {
        sky(["#0a4a7a", "#063256", "#031a34", "#010a1a"], 0, H);
        g.globalAlpha = 0.08;
        for (let k = 0; k < 5; k++)
          for (let y = 0; y < 240; y++) R("#bfefff", 20 + k * 35 + y * 0.25, y, 7, 1);
        g.globalAlpha = 1;
        ridge("#2e2a20", (x) => 300 + 4 * Math.sin(x * 0.08));
        for (let i = 0; i < 10; i++) {
          const x0 = r() * W,
            h = 30 + r() * 60;
          for (let y = 0; y < h; y++)
            R(i % 2 ? "#1a6a4a" : "#2a8a5a", x0 + Math.sin(y * 0.15 + i) * 3, 300 - y, 2, 1);
        }
        for (let i = 0; i < 5; i++) {
          const x = r() * W,
            y = 40 + r() * 180;
          R("#ffa040", x, y, 6, 3);
          R("#ffa040", x + 6, y - 1, 2, 5);
          R("#000", x + 1, y + 1, 1, 1);
        }
      },
    },
    // Ringed planet and an orbiting space station.
    {
      name: "SPACE DOCK",
      acc: "#ff9a6a",
      part: "twinkle",
      n: 30,
      draw(r) {
        sky(["#000008", "#0a0a2a", "#1a1040"], 0, H);
        for (let i = 0; i < 90; i++) R(["#fff", "#a8b8ff", "#ffd0a0"][i % 3], r() * W, r() * H, 1, 1);
        g.save();
        g.beginPath();
        g.rect(0, 0, W, H);
        g.clip();
        circ("#c8603a", 36, 250, 50);
        for (let y = 210; y < 300; y += 9) R("#a04a2a", 0, y, 90, 3);
        circ("#e8885a", 22, 228, 10);
        g.restore();
        for (let x = -20; x < 100; x++) {
          const y = 250 + (x - 36) * 0.18;
          R("#ffd0a0", x, y, 1, 1);
        }
        R("#6a6a84", 96, 56, 64, 10);
        R("#9a9ab4", 96, 56, 64, 2);
        R("#3a6ad8", 104, 44, 14, 34);
        R("#3a6ad8", 138, 44, 14, 34);
        R("#c8c8e0", 123, 46, 10, 30);
        R("#ff5050", 127, 40, 2, 6);
      },
    },
    // Orange trees and falling leaves.
    {
      name: "AUTUMN WOODS",
      acc: "#ffe0a0",
      part: "leaf",
      n: 36,
      draw(r) {
        sky(["#ff9a5a", "#ffc890", "#fff0d0"], 0, H);
        circ("#fff4d8", 130, 60, 14);
        ridge("#c86a30", (x) => 200 + 14 * Math.sin(x * 0.04 + 1));
        for (let i = 0; i < 9; i++) {
          const x = 10 + i * 20 + r() * 8,
            y = 210 + r() * 40;
          R("#5a3018", x - 1, y, 3, 60);
          circ(["#d8501a", "#f08a20", "#b8301a"][i % 3], x, y - 6, 9 + r() * 5);
          circ(["#ffb040", "#ff7a1a", "#e8501a"][i % 3], x - 3, y - 9, 4);
        }
        ridge("#7a4a20", (x) => 285 + 5 * Math.sin(x * 0.09));
        for (let i = 0; i < 30; i++) R(["#d8501a", "#ffb040"][i % 2], r() * W, 288 + r() * 30, 2, 1);
      },
    },
    // Pastel sky, lollipops and confetti.
    {
      name: "CANDY CLOUDS",
      acc: "#ffffff",
      part: "confetti",
      n: 34,
      draw(r) {
        sky(["#ff8ac8", "#ffc0e0", "#c0e4ff"], 0, H);
        for (let i = 0; i < 6; i++) {
          const cx = r() * W,
            cy = 30 + r() * 200;
          for (let j = 0; j < 4; j++) circ("#ffffff", cx + j * 7 - 10, cy - (j % 2) * 4, 6 + r() * 3);
          R("#ffe4f4", cx - 16, cy + 4, 36, 3);
        }
        for (const [x, c] of [
          [24, "#ff5a8a"],
          [156, "#5ad0ff"],
          [90, "#ffd23a"],
        ]) {
          R("#ffffff", x, 250, 2, 70);
          circ(c, x + 1, 244, 12);
          circ("#ffffff", x + 1, 244, 7);
          circ(c, x + 1, 244, 4);
        }
        ridge("#ff9ad0", (x) => 298 + 5 * Math.sin(x * 0.1));
        for (let x = 0; x < W; x += 8) R("#ffffff", x, 302, 4, 18);
      },
    },
    // Castle silhouette, full moon and bats.
    {
      name: "HAUNTED HILL",
      acc: "#c88aff",
      part: "bat",
      n: 10,
      draw(r) {
        sky(["#0a0418", "#2a0a3a", "#4a1a5a"], 0, H);
        for (let i = 0; i < 40; i++) R("#c8b8ff", r() * W, r() * 160, 1, 1);
        circ("#e8e0ff", 128, 66, 22);
        circ("#c8bce8", 120, 60, 4);
        circ("#c8bce8", 136, 74, 3);
        ridge("#160a22", (x) => 220 + 12 * Math.sin(x * 0.035));
        const k = "#08040e";
        R(k, 40, 150, 60, 80);
        R(k, 32, 120, 16, 110);
        R(k, 92, 120, 16, 110);
        R(k, 58, 100, 24, 60);
        for (const [x, y] of [
          [32, 114],
          [92, 114],
          [58, 94],
        ])
          for (let i = 0; i < 4; i++) R(k, x + i * 5, y, 3, 6);
        for (const [x, y] of [
          [38, 140],
          [98, 140],
          [66, 116],
          [54, 170],
          [80, 170],
        ])
          R("#ffd040", x, y, 3, 5);
        ridge("#0c0614", (x) => 270 + 6 * Math.sin(x * 0.07));
        for (let i = 0; i < 6; i++) {
          const x = 10 + r() * 160;
          R("#3a2a4a", x, 262, 6, 9);
          R("#3a2a4a", x + 1, 260, 4, 2);
        }
      },
    },
    // STORY SCENE 1 - volcanic dawn. The sun rises as the wave progresses.
    {
      name: "FIRST LIGHT",
      acc: "#ffb070",
      part: "none",
      n: 0,
      th: ["IT ALL STARTED", "WITH ONE SPARK."],
      draw(r) {
        sky(["#1a0a2a", "#5a1a3a", "#c8503a", "#ffb070"], 0, 210, [["#2a1030", "#120818"], 210, H]);
        tri("#140810", 28, 168, 211, 30);
        tri("#1a0a14", 156, 184, 211, 24);
        for (let i = 0; i < 6; i++) circ("#3a2a3a", 30 + i * 3, 160 - i * 9, 3 + i);
        for (let y = 216; y < H; y += 5) R("#3a1a3a", r() * W, y, 8 + r() * 20, 1);
      },
      live(pf) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, 210);
        ctx.clip();
        const y = 232 - pf * 112;
        ctx.globalAlpha = 0.25;
        cc("#ffd080", 100, y, 26);
        ctx.globalAlpha = 1;
        cc("#fff0a0", 100, y, 15);
        ctx.restore();
        ctx.globalAlpha = 0.25 + pf * 0.5;
        ctx.fillStyle = "#ffd080";
        for (let i = 0; i < 10; i++) {
          const w = 14 - i;
          ctx.fillRect(100 - w, 214 + i * 5, w * 2, 1);
        }
        ctx.globalAlpha = 1;
      },
    },
    // STORY SCENE 2 - standing stones. The sun sets and stars appear.
    {
      name: "STONE CIRCLE",
      acc: "#ffc880",
      part: "none",
      n: 0,
      th: ["WE'VE ALWAYS STACKED", "STONES TO COUNT TIME."],
      draw(r) {
        sky(["#1a1a40", "#5a3a6a", "#e07a5a", "#ffc880"], 0, 222);
        ridge("#2a3a20", (x) => 222 + 4 * Math.sin(x * 0.05));
        ridge("#1c2a16", (x) => 262 + 6 * Math.sin(x * 0.04 + 1));
        const k = "#1a1814",
          e = "#3a342c";
        for (const [x, h] of [
          [4, 64],
          [36, 64],
          [132, 58],
          [162, 58],
        ]) {
          R(k, x, 222 - h, 11, h);
          R(e, x, 222 - h, 2, h);
        }
        R(k, 2, 152, 47, 9);
        R(e, 2, 152, 47, 2);
        R(k, 130, 160, 45, 8);
        R(e, 130, 160, 45, 2);
        for (let i = 0; i < 5; i++) {
          const x = 58 + i * 16;
          R(k, x, 200 - (i % 2) * 6, 9, 30);
        }
      },
      live(pf) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, 221);
        ctx.clip();
        cc("#fff0c0", 26, 168 + pf * 58, 9);
        ctx.restore();
        ctx.fillStyle = "#fff";
        const rs = rng(77);
        for (let i = 0; i < 34; i++) {
          const x = rs() * W,
            y = 34 + rs() * 110;
          if (rs() < pf) ctx.fillRect(x | 0, y | 0, 1, 1);
        }
      },
    },
    // STORY SCENE 3 - a sweeping beam. The storm calms as you progress.
    {
      name: "LIGHTHOUSE",
      acc: "#fff8c0",
      part: "rain",
      n: 70,
      calm: 1,
      th: ["SOMEONE KEEPS A LIGHT", "ON FOR STRANGERS."],
      draw(r) {
        sky(["#0a1020", "#1a2a40", "#2e3e54"], 0, 222, [["#0a1a2a", "#04101a"], 222, H]);
        for (let i = 0; i < 7; i++) {
          const cx = r() * W,
            cy = 40 + r() * 80;
          for (let j = 0; j < 3; j++) circ("#141c2c", cx + j * 9 - 9, cy, 8 + r() * 4);
        }
        ridge("#10100e", (x) => (x < 56 ? 150 + x * 0.5 : 232 + 4 * Math.sin(x * 0.1)));
        for (let y = 66; y < 150; y++) {
          const w = 7 - (y - 66) * 0.03;
          R(((y - 66) >> 3) % 2 ? "#c83030" : "#e8e8e8", 24 - w, y, w * 2, 1);
        }
        R("#2a2a2a", 14, 58, 20, 8);
        R("#ffe890", 17, 60, 14, 6);
        R("#2a2a2a", 15, 54, 18, 4);
        for (let y = 228; y < H; y += 6) R("#4a6a8a", r() * W, y, 6 + r() * 14, 1);
      },
      live(pf, t) {
        const a = t * 1.3,
          s = 0.18,
          L = 260;
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = "#fff8c0";
        ctx.beginPath();
        ctx.moveTo(24, 63);
        ctx.lineTo(24 + Math.cos(a - s) * L, 63 + Math.sin(a - s) * L * 0.35);
        ctx.lineTo(24 + Math.cos(a + s) * L, 63 + Math.sin(a + s) * L * 0.35);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (Math.cos(a) > 0.7) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(17, 60, 14, 6);
        }
      },
    },
    // STORY SCENE 4 - the computer loads, then shows a tiny Tilefall.
    {
      name: "BEDROOM 1985",
      acc: "#ffd23a",
      part: "none",
      n: 0,
      th: ["THE WAIT WAS", "HALF THE MAGIC."],
      draw(r) {
        sky(["#2a1e3a", "#1e1630"], 0, H);
        for (let y = 0; y < 300; y += 10) R("#251b35", 0, y, W, 1);
        R("#5a4a3a", 4, 38, 38, 44);
        sky0(6, 40, 34, 40, "#0a0a28");
        circ("#e8e8c8", 30, 50, 5);
        for (let i = 0; i < 8; i++) R("#fff", 8 + r() * 30, 44 + r() * 34, 1, 1);
        R("#5a4a3a", 22, 40, 2, 40);
        R("#5a4a3a", 6, 59, 34, 2);
        R("#6a4a2a", 134, 100, 46, 6);
        R("#4a321c", 136, 106, 4, 70);
        R("#4a321c", 174, 106, 4, 70);
        R("#c8bc9c", 142, 60, 34, 38);
        R("#8a7e64", 142, 96, 34, 2);
        R("#0a0a0a", 146, 64, 26, 24);
        R("#b0a484", 152, 98, 22, 3);
        R("#c8bc9c", 138, 92, 42, 6);
        for (let x = 140; x < 178; x += 3) R("#8a7e64", x, 93, 2, 2);
        R("#ff5050", 172, 89, 2, 2);
        R("#3a2a20", 0, 300, W, 20);
        R("#8a2a4a", 20, 304, 140, 10);
        R("#e8d8b0", 4, 96, 26, 34);
        R("#3a6ad8", 6, 98, 22, 30);
        R("#ffffff", 16, 104, 2, 14);
        R("#ff8a2a", 15, 118, 4, 4);
        R("#c8c8e0", 13, 112, 2, 6);
        R("#c8c8e0", 19, 112, 2, 6);
      },
      live(pf, t) {
        if (pf < 0.12 || (S.state === "title" && t % 6 < 2)) {
          for (let y = 64; y < 88; y += 2) {
            ctx.fillStyle = TAPE[(Math.random() * TAPE.length) | 0];
            ctx.fillRect(146, y, 26, 2);
          }
          ctx.fillStyle = "#0a0a0a";
          ctx.fillRect(150, 70, 18, 12);
          return;
        }
        ctx.fillStyle = "#04101a";
        ctx.fillRect(146, 64, 26, 24);
        ctx.fillStyle = "#5ee6a0";
        ctx.fillRect(149, 84, 20, 1);
        for (let i = 0; i < 3; i++) {
          const y = 66 + ((t * 12 + i * 7) % 17);
          ctx.fillStyle = COLS[i];
          ctx.fillRect(151 + i * 6, y | 0, 4, 2);
        }
        for (let i = 0; i < Math.round(pf * 5); i++) {
          ctx.fillStyle = COLS[(i + 2) % 7];
          ctx.fillRect(150 + i * 4, 82, 3, 2);
        }
        if (((t * 2) | 0) % 2) {
          ctx.fillStyle = "#5ee6a0";
          ctx.fillRect(168, 65, 2, 3);
        }
      },
    },
    // STORY SCENE 5 - countdown runs; the rocket lifts off on wave clear.
    {
      name: "LAUNCH PAD",
      acc: "#ffffff",
      part: "twinkle",
      n: 24,
      th: ["EVERY GIANT LEAP", "STARTS ON THE GROUND."],
      draw(r) {
        sky(["#020818", "#0a1a3a", "#1a2a50"], 0, H);
        for (let i = 0; i < 70; i++) R("#c8d8ff", r() * W, r() * 200, 1, 1);
        ridge("#14141a", (x) => 288 + 2 * Math.sin(x * 0.2));
        for (let y = 40; y < 288; y += 6) {
          R("#5a5a6a", 168, y, 1, 6);
          R("#5a5a6a", 176, y, 1, 6);
          R("#5a5a6a", 168, y, 9, 1);
        }
        R("#5a5a6a", 158, 84, 10, 1);
        R("#5a5a6a", 158, 140, 10, 1);
        R("#2a2a34", 140, 282, 40, 6);
        R("#ff5050", 170, 38, 2, 2);
      },
      live(pf, t) {
        const go = S.state === "clear",
          k = go ? S.stateT : 0,
          dy = go ? k * k * 60 : 0,
          x = 152,
          y = 80 - dy;
        if (go) {
          for (let i = 0; i < 8; i++) {
            ctx.globalAlpha = 0.6;
            cc(
              "#8a8a9a",
              x + 5 + (Math.random() - 0.5) * 16,
              286 - Math.random() * 10,
              4 + Math.random() * 4,
            );
          }
          ctx.globalAlpha = 1;
          ctx.fillStyle = Math.random() < 0.5 ? "#ffd23a" : "#ff7a1a";
          ctx.fillRect(x + 2, y + 96, 7, 8 + Math.random() * 10);
          ctx.fillStyle = "#fff";
          ctx.fillRect(x + 4, y + 96, 3, 5);
        }
        ctx.fillStyle = "#e8e8f0";
        ctx.fillRect(x, y + 12, 11, 84);
        ctx.fillStyle = "#a8a8b8";
        ctx.fillRect(x + 8, y + 12, 3, 84);
        ctx.fillStyle = "#c83030";
        ctx.fillRect(x + 2, y + 4, 7, 8);
        ctx.fillRect(x + 4, y, 3, 4);
        ctx.fillRect(x - 4, y + 84, 4, 12);
        ctx.fillRect(x + 11, y + 84, 4, 12);
        ctx.fillStyle = "#3a6ad8";
        ctx.fillRect(x + 3, y + 30, 5, 5);
        if (!go && S.state !== "title")
          txt(
            "T-" + String(Math.max(0, Math.ceil(10 * (1 - pf)))).padStart(2, "0"),
            4,
            36,
            "#ff6060",
            "left",
          );
      },
    },
    // STORY SCENE 6 - deep space and one tiny blue pixel.
    {
      name: "PALE DOT",
      acc: "#6ab4ff",
      part: "twinkle",
      n: 30,
      th: ["EVERYONE YOU KNOW,", "ON ONE TINY PIXEL."],
      draw(r) {
        sky(["#000004", "#05051a", "#0a0a24"], 0, H);
        for (let i = 0; i < 120; i++) R(["#fff", "#c8c8ff", "#ffe0c0"][i % 3], r() * W, r() * H, 1, 1);
        g.globalAlpha = 0.07;
        for (const [x0, c] of [
          [110, "#ffc890"],
          [140, "#ff9a6a"],
          [166, "#ffc890"],
        ])
          for (let y = 0; y < H; y++) R(c, x0 - y * 0.35, y, 6, 1);
        g.globalAlpha = 1;
      },
      live(pf, t) {
        const x = 150,
          y = 58,
          ph = (t % 2) / 2;
        ctx.strokeStyle = "rgba(106,180,255," + (0.7 - ph * 0.7).toFixed(2) + ")";
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 2 - ph * 8, y - 2 - ph * 8, 5 + ph * 16, 5 + ph * 16);
        ctx.fillStyle = "#6ab4ff";
        ctx.fillRect(x, y, 1, 1);
        ctx.globalAlpha = 0.4 + pf * 0.6;
        ctx.fillStyle = "#c8e4ff";
        ctx.fillRect(x + 6, y + 6, 6, 1);
        ctx.fillRect(x + 6, y + 6, 1, 6);
        ctx.globalAlpha = 1;
      },
    },
  ];

  // Thoughts for the first 12 scenes (the story scenes define their own).
  const THO = [
    ["THE LIGHT YOU SEE", "LEFT LONG AGO."],
    ["ENDINGS CAN BE", "BEAUTIFUL TOO."],
    ["SLOW DOWN.", "THE HILLS WILL WAIT."],
    ["A MILLION WINDOWS,", "A MILLION STORIES."],
    ["THEY BUILT THESE", "WITHOUT A SCREEN."],
    ["STILL WATER,", "HOLDING ITS BREATH."],
    ["NEW LAND IS BORN", "FROM FIRE."],
    ["MOST OF OUR WORLD", "IS STILL UNSEEN."],
    ["HOME IS A PLACE", "YOU CAN LEAVE."],
    ["TREES LET GO", "AND GROW BACK."],
    ["REMEMBER WHEN", "THIS WAS ENOUGH?"],
    ["THE DARK IS JUST", "LIGHT, RESTING."],
  ];

  // Give every scene its thought.
  TH.forEach((t, i) => {
    if (!t.th) t.th = THO[i];
  });

  // Plain rectangle on the scene canvas (used for the bedroom window).
  function sky0(x, y, w, h, c) {
    R(c, x, y, w, h);
  }

  // Filled pixel circle drawn straight onto the game canvas, for the
  // animated parts of scenes (suns, smoke, the rocket).
  const cc = (c, cx, cy, r) => {
    ctx.fillStyle = c;
    r = Math.max(0, r | 0);
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      ctx.fillRect(Math.round(cx - w), Math.round(cy + dy), w * 2 + 1, 1);
    }
  };

  // How far through the current wave the player is, from 0 to 1.
  // This drives the scenes that change as you play.
  function pfrac() {
    if (S.state === "title" || S.state === "boot") return 0;
    if (S.state === "clear") return 1;
    return Math.max(0, Math.min(1, S.goal ? S.prog / S.goal : 0));
  }

  // Choose this wave's scene, paint it, and scatter its particles.
  function buildBg() {
    S.theme = (S.level - 1 + S.bgOff) % TH.length;
    const T = TH[S.theme];
    g.clearRect(0, 0, W, H);
    T.draw(rng(S.theme * 977 + 13));
    S.parts = Array.from({ length: T.n }, () => ({
      x: Math.random() * W,
      y: T.part === "sand" ? 200 + Math.random() * 120 : Math.random() * H,
      ph: Math.random() * 6.28,
      s: 0.5 + Math.random(),
    }));
  }

  // Move and draw the scene's particles; each particle type moves its own way.
  function drawParts(dt) {
    const T = TH[S.theme],
      t = now / 1000,
      lim = T.calm ? Math.ceil(S.parts.length * (1 - 0.85 * pfrac())) : S.parts.length;
    for (let pi = 0; pi < lim; pi++) {
      const p = S.parts[pi];
      switch (T.part) {
        case "twinkle": {
          const v = Math.sin(t * 2 * p.s + p.ph),
            x = p.x | 0,
            y = (p.y * 0.7) | 0;
          if (v > 0.2) {
            ctx.fillStyle = "#fff";
            ctx.fillRect(x, y, 1, 1);
            if (v > 0.93) {
              ctx.fillRect(x - 1, y, 3, 1);
              ctx.fillRect(x, y - 1, 1, 3);
            }
          }
          break;
        }
        case "rain":
          p.y += 230 * dt * p.s;
          p.x -= 50 * dt;
          if (p.y > H) {
            p.y = -4;
            p.x = Math.random() * W * 1.3;
          }
          ctx.fillStyle = "rgba(150,180,255,.55)";
          ctx.fillRect(p.x | 0, p.y | 0, 1, 3);
          ctx.fillRect((p.x | 0) - 1, (p.y | 0) + 3, 1, 2);
          break;
        case "snow":
          p.y += 18 * dt * p.s;
          p.x += Math.sin(t + p.ph) * 8 * dt;
          if (p.y > H) p.y = -2;
          ctx.fillStyle = "#e8fbff";
          ctx.fillRect(p.x | 0, p.y | 0, p.s > 1 ? 2 : 1, p.s > 1 ? 2 : 1);
          break;
        case "ember":
          p.y -= 28 * dt * p.s;
          p.x += Math.sin(t * 2 + p.ph) * 10 * dt;
          if (p.y < 0) {
            p.y = H;
            p.x = Math.random() * W;
          }
          ctx.fillStyle = p.s > 1 ? "#ffd040" : "#ff5a10";
          ctx.fillRect(p.x | 0, p.y | 0, 1, 1);
          break;
        case "bubble": {
          p.y -= 22 * dt * p.s;
          p.x += Math.sin(t * 3 + p.ph) * 6 * dt;
          if (p.y < 0) {
            p.y = H;
            p.x = Math.random() * W;
          }
          const x = p.x | 0,
            y = p.y | 0;
          ctx.fillStyle = "rgba(180,240,255,.7)";
          ctx.fillRect(x + 1, y, 1, 1);
          ctx.fillRect(x, y + 1, 1, 1);
          ctx.fillRect(x + 2, y + 1, 1, 1);
          ctx.fillRect(x + 1, y + 2, 1, 1);
          break;
        }
        case "sand":
          p.x += 80 * dt * p.s;
          if (p.x > W) {
            p.x = -2;
            p.y = 200 + Math.random() * 120;
          }
          ctx.fillStyle = "rgba(255,240,192,.7)";
          ctx.fillRect(p.x | 0, p.y | 0, 2, 1);
          break;
        case "leaf": {
          p.y += 20 * dt * p.s;
          p.x += Math.sin(t * 2 + p.ph) * 20 * dt;
          if (p.y > H) {
            p.y = -2;
            p.x = Math.random() * W;
          }
          ctx.fillStyle = ["#d8501a", "#f08a20", "#ffd040"][((p.ph * 10) | 0) % 3];
          const fl = Math.sin(t * 5 + p.ph) > 0;
          ctx.fillRect(p.x | 0, p.y | 0, fl ? 2 : 1, fl ? 1 : 2);
          break;
        }
        case "confetti": {
          p.y += 24 * dt * p.s;
          p.x += Math.sin(t * 3 + p.ph) * 12 * dt;
          if (p.y > H) {
            p.y = -2;
            p.x = Math.random() * W;
          }
          ctx.fillStyle = COLS[((p.ph * 10) | 0) % 7];
          ctx.fillRect(p.x | 0, p.y | 0, 2, 2);
          break;
        }
        case "bat": {
          p.x += 26 * dt * p.s;
          if (p.x > W + 6) {
            p.x = -6;
            p.y = Math.random() * H;
          }
          const x = p.x | 0,
            y = (20 + p.y * 0.4 + Math.sin(t * 2 + p.ph) * 6) | 0,
            up = Math.sin(t * 14 + p.ph) > 0;
          ctx.fillStyle = "#000";
          ctx.fillRect(x, y, 2, 2);
          ctx.fillRect(x - 3, y + (up ? -1 : 1), 3, 1);
          ctx.fillRect(x + 2, y + (up ? -1 : 1), 3, 1);
          break;
        }
        case "cloud": {
          p.x += 5 * dt * p.s;
          if (p.x > W + 20) p.x = -30;
          const x = p.x | 0,
            y = (30 + p.y * 0.25) | 0;
          ctx.fillStyle = "rgba(255,255,255,.85)";
          ctx.fillRect(x, y, 22, 4);
          ctx.fillRect(x + 4, y - 3, 10, 3);
          ctx.fillRect(x + 12, y - 2, 6, 2);
          break;
        }
      }
    }
  }

  // ======================================================================
  // 5. SOUND AND MUSIC
  // Nothing is recorded: every note is synthesised live. Pulse waves give
  // the classic chip sound, triangle waves the bass, white noise the drums.
  // Browsers only allow sound after the first tap, which is why the game
  // opens with TAP TO LOAD.
  // ======================================================================
  // The audio system, music and effects volume controls, a noise sample,
  // two pulse-wave shapes, and the music scheduler's position.
  let ac = null,
    mGain,
    sGain,
    nBuf,
    P25,
    P12,
    P50,
    mTimer = null,
    nextT = 0,
    step = 0;

  // Build a pulse wave with the given duty cycle (0.5 = square wave).
  // Thinner pulses (12.5%, 25%) give the nasal 8-bit tone.
  function pw(du) {
    const n = 48,
      re = new Float32Array(n),
      im = new Float32Array(n);
    for (let k = 1; k < n; k++) re[k] = (2 * Math.sin(k * Math.PI * du)) / (k * Math.PI);
    return ac.createPeriodicWave(re, im);
  }

  // Create the audio system on the first tap (browsers require a tap first).
  function initAudio() {
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return;
    try {
      ac = new A();
    } catch (e) {
      return;
    }
    const m = ac.createGain();
    m.gain.value = 0.6;
    m.connect(ac.destination);
    mGain = ac.createGain();
    mGain.gain.value = musicOn ? 0.3 : 0;
    mGain.connect(m);
    sGain = ac.createGain();
    sGain.gain.value = 0.5;
    sGain.connect(m);
    nBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = nBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    P25 = pw(0.25);
    P12 = pw(0.125);
    P50 = pw(0.5);
  }

  // MIDI note number to frequency in Hz (note 69 = A = 440Hz).
  const mf = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // Play one note.
  //   w    waveform        f    frequency (Hz)    t    start time
  //   dur  length (s)      v    volume            dst  music or effects channel
  //   f2   optional pitch to slide to             vib  add vibrato (long notes)
  function tone(w, f, t, dur, v, dst, f2, vib) {
    const o = ac.createOscillator(),
      gn = ac.createGain();
    if (typeof w === "string") o.type = w;
    else o.setPeriodicWave(w);
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    if (vib) {
      const l = ac.createOscillator(),
        lg = ac.createGain();
      l.frequency.value = 6;
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(f * 0.008, t + dur * 0.6);
      l.connect(lg);
      lg.connect(o.frequency);
      l.start(t);
      l.stop(t + dur + 0.05);
    }
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.exponentialRampToValueAtTime(v, t + 0.006);
    gn.gain.setValueAtTime(v, t + dur * 0.75);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(gn);
    gn.connect(dst);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  // Play a burst of filtered white noise: drums, crashes, tape hiss.
  function noise(t, dur, v, hp, dst) {
    const s = ac.createBufferSource(),
      f = ac.createBiquadFilter(),
      gn = ac.createGain();
    s.buffer = nBuf;
    f.type = "highpass";
    f.frequency.value = hp;
    gn.gain.setValueAtTime(v, t);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(gn);
    gn.connect(dst);
    s.start(t);
    s.stop(t + dur + 0.02);
  }

  // THE MUSIC
  // Songs are 8 bars of 16 steps. Each melody note is
  //   [step within the bar (0-15), MIDI note number, length in steps]
  //
  // Main game melody, over the chords Am  F  C  G  Am  F  C  E.
  const MEL = [
    [
      [0, 76, 2],
      [2, 81, 2],
      [4, 79, 2],
      [6, 76, 2],
      [8, 72, 2],
      [10, 74, 2],
      [12, 76, 4],
    ],
    [
      [0, 77, 2],
      [2, 76, 2],
      [4, 74, 2],
      [6, 72, 2],
      [8, 74, 4],
      [12, 69, 4],
    ],
    [
      [0, 72, 2],
      [2, 76, 2],
      [4, 79, 2],
      [6, 84, 2],
      [8, 83, 2],
      [10, 79, 2],
      [12, 76, 4],
    ],
    [
      [0, 74, 2],
      [2, 76, 1],
      [3, 74, 1],
      [4, 71, 2],
      [6, 67, 2],
      [8, 71, 2],
      [10, 74, 2],
      [12, 79, 4],
    ],
    [
      [0, 81, 3],
      [3, 81, 1],
      [4, 79, 2],
      [6, 81, 2],
      [8, 84, 4],
      [12, 83, 2],
      [14, 81, 2],
    ],
    [
      [0, 79, 3],
      [3, 77, 1],
      [4, 76, 2],
      [6, 77, 2],
      [8, 81, 4],
      [12, 77, 4],
    ],
    [
      [0, 79, 3],
      [3, 79, 1],
      [4, 76, 2],
      [6, 79, 2],
      [8, 84, 2],
      [10, 83, 2],
      [12, 79, 2],
      [14, 76, 2],
    ],
    [
      [0, 74, 2],
      [2, 71, 2],
      [4, 74, 2],
      [6, 79, 2],
      [8, 80, 4],
      [12, 76, 4],
    ],
  ];

  // Alternative, bouncier melody over the same chords (used on even waves).
  const MEL2 = [
    [
      [0, 69, 1],
      [1, 72, 1],
      [2, 76, 2],
      [4, 76, 1],
      [6, 74, 1],
      [7, 76, 3],
      [10, 79, 2],
      [12, 76, 2],
      [14, 74, 2],
    ],
    [
      [0, 72, 3],
      [3, 69, 1],
      [4, 72, 2],
      [6, 77, 2],
      [8, 76, 3],
      [11, 74, 1],
      [12, 72, 4],
    ],
    [
      [0, 67, 1],
      [1, 72, 1],
      [2, 76, 2],
      [4, 79, 1],
      [6, 79, 1],
      [7, 81, 3],
      [10, 79, 2],
      [12, 76, 4],
    ],
    [
      [0, 74, 2],
      [2, 79, 2],
      [4, 83, 2],
      [6, 81, 2],
      [8, 79, 3],
      [11, 74, 1],
      [12, 71, 4],
    ],
    [
      [0, 81, 1],
      [1, 84, 1],
      [2, 88, 2],
      [4, 84, 2],
      [6, 81, 2],
      [8, 76, 2],
      [10, 79, 2],
      [12, 81, 4],
    ],
    [
      [0, 77, 1],
      [1, 81, 1],
      [2, 84, 2],
      [4, 81, 2],
      [6, 77, 2],
      [8, 76, 2],
      [10, 77, 2],
      [12, 72, 4],
    ],
    [
      [0, 76, 2],
      [2, 79, 1],
      [3, 84, 3],
      [6, 83, 2],
      [8, 79, 2],
      [10, 76, 2],
      [12, 79, 2],
      [14, 84, 2],
    ],
    [
      [0, 83, 3],
      [3, 80, 1],
      [4, 76, 2],
      [6, 80, 2],
      [8, 83, 4],
      [12, 88, 2],
      [14, 83, 2],
    ],
  ];

  // Title screen melody in C major, over C  G  Am  F.
  const TMEL = [
    [
      [0, 72, 2],
      [2, 72, 1],
      [3, 76, 1],
      [4, 79, 2],
      [6, 76, 2],
      [8, 84, 3],
      [11, 83, 1],
      [12, 79, 4],
    ],
    [
      [0, 74, 2],
      [2, 74, 1],
      [3, 79, 1],
      [4, 83, 2],
      [6, 79, 2],
      [8, 86, 3],
      [11, 84, 1],
      [12, 83, 4],
    ],
    [
      [0, 81, 2],
      [2, 79, 2],
      [4, 76, 2],
      [6, 72, 2],
      [8, 76, 2],
      [10, 79, 2],
      [12, 81, 4],
    ],
    [
      [0, 77, 2],
      [2, 76, 2],
      [4, 74, 2],
      [6, 72, 2],
      [8, 74, 4],
      [12, 79, 4],
    ],
    [
      [0, 72, 2],
      [2, 72, 1],
      [3, 76, 1],
      [4, 79, 2],
      [6, 76, 2],
      [8, 84, 3],
      [11, 83, 1],
      [12, 79, 4],
    ],
    [
      [0, 74, 2],
      [2, 74, 1],
      [3, 79, 1],
      [4, 83, 2],
      [6, 79, 2],
      [8, 86, 3],
      [11, 84, 1],
      [12, 83, 4],
    ],
    [
      [0, 81, 2],
      [2, 84, 2],
      [4, 81, 2],
      [6, 77, 2],
      [8, 76, 2],
      [10, 77, 2],
      [12, 81, 4],
    ],
    [
      [0, 79, 2],
      [2, 83, 2],
      [4, 86, 2],
      [6, 83, 2],
      [8, 86, 2],
      [10, 83, 2],
      [12, 79, 2],
      [14, 74, 2],
    ],
  ];

  // Game bass notes (GB) and chord notes for the arpeggios (GC), one per bar.
  const GB = [45, 41, 48, 43, 45, 41, 48, 40],
    GC = [
      [57, 60, 64],
      [53, 57, 60],
      [55, 60, 64],
      [55, 59, 62],
      [57, 60, 64],
      [53, 57, 60],
      [55, 60, 64],
      [56, 59, 64],
    ];

  // The title tune: its bass, chords, melody and speed, plus
  //   bs bass style, as arpeggio pattern, ds drum pattern,
  //   lw lead sound, echo = repeat the melody quietly like a delay pedal.
  const TITLE = {
    id: "title",
    bass: [48, 43, 45, 41, 48, 43, 41, 43],
    ch: [
      [60, 64, 67],
      [59, 62, 67],
      [57, 60, 64],
      [57, 60, 65],
      [60, 64, 67],
      [59, 62, 67],
      [57, 60, 65],
      [59, 62, 67],
    ],
    mel: TMEL,
    tempo: 150,
    tr: 0,
    bs: 3,
    as: 2,
    ds: 1,
    lw: 0,
    echo: true,
  };

  // Key change for each wave (in semitones), arpeggio patterns, and a
  // cache so each wave's song is only built once.
  const TR = [0, 2, -3, 5, 0, 3, -2, 4],
    ARPS = [
      [0, 1, 2],
      [2, 1, 0],
      [0, 1, 2, 1],
      [0, 2, 1, 2],
    ],
    songs = {};

  // Choose what to play: silence during start-up, the title tune on the
  // title screen, a faster title tune in bonus rounds, otherwise a version of
  // the game tune whose melody, bass, drums and sound change every wave.
  function curSong() {
    if (S.state === "boot") return null;
    if (S.state === "title") return TITLE;
    const L = S.level;
    if (S.wtype === "bonus" && S.state !== "over" && S.state !== "entry")
      return (
        songs["b" + L] ||
        (songs["b" + L] = Object.assign({}, TITLE, { id: "b" + L, tempo: 170, tr: TR[(L - 1) % 8] }))
      );
    if (songs[L]) return songs[L];
    const v = L - 1;
    return (songs[L] = {
      id: "g" + L,
      bass: GB,
      ch: GC,
      mel: v % 2 ? MEL2 : MEL,
      tempo: Math.min(176, 132 + v * 4),
      tr: TR[v % 8],
      bs: Math.floor(v / 2) % 3,
      as: v % 4,
      ds: Math.floor(v / 3) % 3,
      lw: Math.floor(v / 2) % 3,
      echo: v % 3 === 2,
    });
  }

  // Play one 16th-note step of a song: bass, arpeggio, melody, then drums.
  function playStep(sg, s, t, sp) {
    const b = s >> 4,
      st = s & 15,
      tr = sg.tr,
      rt = sg.bass[b] + tr;
    if (sg.bs === 0) {
      if (st % 2 === 0) tone("triangle", mf(rt + (st % 4 ? 12 : 0)), t, sp * 1.7, 0.42, mGain);
    } else if (sg.bs === 1) {
      const k = st % 4;
      if (k !== 1) tone("triangle", mf(rt + (k ? 12 : 0)), t, sp * 0.9, 0.42, mGain);
    } else if (sg.bs === 2) {
      if (st % 4 === 0) tone("triangle", mf(rt + [0, 7, 12, 7][st >> 2]), t, sp * 3.5, 0.42, mGain);
    } else if (st % 2 === 0)
      tone("triangle", mf(rt + [0, 12, 7, 12][(st >> 1) % 4]), t, sp * 1.6, 0.42, mGain);
    const ap = ARPS[sg.as];
    tone(P12, mf(sg.ch[b][ap[st % ap.length]] + 12 + tr), t, sp * 0.8, 0.05, mGain);
    const lw = [P25, P50, P12][sg.lw];
    for (const e of sg.mel[b])
      if (e[0] === st) {
        tone(lw, mf(e[1] + tr), t, e[2] * sp * 0.92, 0.15, mGain, 0, e[2] >= 3);
        if (sg.echo) tone(lw, mf(e[1] + tr), t + sp * 3, e[2] * sp * 0.8, 0.05, mGain);
      }
    const kick = () => tone("sine", 150, t, 0.13, 0.7, mGain, 40),
      snare = (v) => noise(t, 0.12, v, 1800, mGain),
      hat = (d, v) => noise(t, d, v, 7000, mGain);
    if (sg.ds === 0) {
      if (st === 0 || st === 8 || (b & 1 && st === 14)) kick();
      if (st === 4 || st === 12) snare(0.25);
      else if (st % 2 === 0) hat(0.03, 0.06);
    } else if (sg.ds === 1) {
      if (st % 4 === 0) kick();
      if (st === 4 || st === 12) snare(0.25);
      if (st % 4 === 2) hat(0.09, 0.08);
      else hat(0.02, 0.03);
    } else {
      if (st === 0 || st === 6 || st === 10) kick();
      if (st === 4 || st === 12) snare(0.25);
      else if (st === 15) snare(0.08);
      hat(0.02, 0.035);
    }
  }

  // The scheduler. Every 25ms it queues the notes due in the next 150ms,
  // which keeps the rhythm tight even if the page briefly stutters.
  let playing = "";
  function seqTick() {
    if (!ac || ac.state !== "running") return;
    const sg = curSong();
    if (!sg) {
      playing = "";
      nextT = ac.currentTime + 0.05;
      return;
    }
    if (sg.id !== playing) {
      playing = sg.id;
      step = 0;
      nextT = Math.max(nextT, ac.currentTime + 0.05);
    }
    const sp = 60 / sg.tempo / 4;
    if (nextT < ac.currentTime - 0.2) nextT = ac.currentTime + 0.05;
    while (nextT < ac.currentTime + 0.15) {
      playStep(sg, step, nextT, sp);
      nextT += sp;
      step = (step + 1) % 128;
    }
  }

  // Start the scheduler (only once).
  function startMusic() {
    if (!ac || mTimer) return;
    nextT = ac.currentTime + 0.08;
    mTimer = setInterval(seqTick, 25);
  }

  // Run a sound effect only when audio is up and running.
  const sf = (fn) => {
    if (ac && ac.state === "running") fn(ac.currentTime);
  };

  // Sound effects.
  const SFX = {
    catch: () => sf((t) => tone("square", 660, t, 0.07, 0.25, sGain, 1320)),
    drop: () => sf((t) => tone("square", 520, t, 0.12, 0.22, sGain, 160)),
    buzz: () => sf((t) => tone("square", 110, t, 0.12, 0.2, sGain)),
    toss: () => sf((t) => tone("square", 300, t, 0.1, 0.2, sGain, 1000)),
    miss: () =>
      sf((t) => {
        noise(t, 0.35, 0.5, 150, sGain);
        tone("sawtooth", 220, t, 0.35, 0.18, sGain, 40);
      }),
    match: (ch) =>
      sf((t) =>
        [0, 4, 7, 12, 16].forEach((n, i) => tone(P25, mf(72 + n + ch * 3), t + i * 0.045, 0.1, 0.25, sGain)),
      ),
    clear: () =>
      sf((t) =>
        [72, 76, 79, 84, 79, 84, 88].forEach((n, i) =>
          tone(P25, mf(n), t + i * 0.1, i === 6 ? 0.5 : 0.12, 0.25, sGain),
        ),
      ),
    zap: () =>
      sf((t) => {
        for (let i = 0; i < 12; i++) tone("square", mf(60 + i * 3), t + i * 0.03, 0.05, 0.18, sGain);
        noise(t, 0.45, 0.3, 700, sGain);
      }),
    over: () =>
      sf((t) => [72, 67, 64, 60, 55].forEach((n, i) => tone(P25, mf(n), t + i * 0.16, 0.18, 0.25, sGain))),
  };

  // The AA Software ident: tape-loading chirps, then a jingle with two
  // punchy hits for the two A's.
  function identAudio() {
    if (!ac) return;
    ac.resume();
    const t0 = ac.currentTime + 0.06;
    for (let i = 0; i < 36; i++) {
      const t = t0 + i * 0.042;
      tone("square", [420, 840, 1260, 630, 980][(Math.random() * 5) | 0], t, 0.04, 0.05, sGain);
      if (i % 3 === 0) noise(t, 0.03, 0.05, 3000, sGain);
    }
    const t = t0 + 1.6;
    [64, 68, 71, 76, 80, 83, 88, 92].forEach((n, i) => tone(P12, mf(n), t + i * 0.045, 0.09, 0.12, sGain));
    const L = [
      [0.45, 76, 0.14],
      [0.62, 76, 0.14],
      [0.95, 83, 0.12],
      [1.1, 81, 0.12],
      [1.25, 80, 0.12],
      [1.4, 83, 0.7],
    ];
    L.forEach(([d, n, len]) => {
      tone(P25, mf(n), t + d, len, 0.22, sGain, 0, len > 0.3);
      tone(P25, mf(n), t + d + 0.18, len * 0.8, 0.06, sGain);
    });
    [
      [0.45, 40, 0.14],
      [0.62, 40, 0.14],
      [0.95, 45, 0.12],
      [1.1, 47, 0.12],
      [1.25, 44, 0.12],
      [1.4, 40, 0.7],
    ].forEach(([d, n, len]) => tone("triangle", mf(n), t + d, len, 0.45, sGain));
    [
      [0.45, 52, 56, 59],
      [1.4, 64, 68, 71],
    ].forEach(([d, ...ns]) => ns.forEach((n) => tone(P50, mf(n), t + d, d > 1 ? 0.7 : 0.12, 0.06, sGain)));
    [0.45, 0.62, 0.95, 1.4].forEach((d) => tone("sine", 150, t + d, 0.13, 0.6, sGain, 40));
    [1.1, 1.17, 1.25, 1.32].forEach((d) => noise(t + d, 0.06, 0.2, 1800, sGain));
    noise(t + 1.4, 0.9, 0.25, 5000, sGain);
  }

  // Called on every tap: creates or resumes audio so sound can play.
  function unlock() {
    if (!ac) {
      initAudio();
      startMusic();
    } else if (ac.state === "suspended" && S.state !== "pause") ac.resume();
  }

  // ======================================================================
  // 6. GAME RULES
  // ======================================================================
  // Set up a new wave: tile speed, number of colours, wave type and goal,
  // lives, an empty bin and the next scene.
  function startLevel() {
    const L = S.level;
    S.stepMs = Math.max(115, 560 - (L - 1) * 30);
    S.spawnMs = Math.max(750, 2900 - (L - 1) * 160);
    S.ncol = Math.min(7, 3 + Math.ceil(L / 2));
    S.wtype = WT[(L - 1) % WT.length];
    S.goal = {
      lines: Math.min(12, 2 + L),
      diag: Math.min(4, 1 + Math.floor(L / 6)),
      score: 1000 + L * 400,
      catch: 12 + L * 2,
      rows: Math.min(8, 1 + Math.floor(L / 2)),
      big: Math.min(3, 1 + Math.floor(L / 10)),
      survive: Math.min(75, 40 + L * 2),
      bonus: 40,
      clearbin: 0,
    }[S.wtype];
    S.prog = 0;
    S.timer = S.goal;
    if (S.wtype === "bonus") S.ncol = 3;
    // Score waves pick a gold colour: lines of that colour score triple.
    S.gold = S.wtype === "score" ? (Math.random() * S.ncol) | 0 : -1;
    S.maxDrops = 3 + Math.floor((L - 1) / 3);
    S.grid = [[], [], [], [], []];
    S.stack = [];
    S.tiles = [];
    S.fallers = [];
    S.drops = 0;
    S.spawnT = 600;
    if (S.wtype === "clearbin") prefill();
    buildBg();
    S.state = "intro";
    S.stateT = 0;
  }

  // The order of wave types; the cycle repeats every 16 waves.
  //   lines    match a number of lines        catch    catch a number of tiles
  //   score    reach a points target          rows     make across lines
  //   diag     make diagonal lines            big      make lines of 4 or more
  //   survive  last until the clock runs out  clearbin clear a pre-filled bin
  //   bonus    clock runs, misses cost nothing, every catch scores
  const WT = [
    "lines",
    "lines",
    "catch",
    "lines",
    "score",
    "rows",
    "diag",
    "bonus",
    "lines",
    "clearbin",
    "big",
    "survive",
    "lines",
    "score",
    "diag",
    "bonus",
  ];

  // For clear-the-bin waves: fill the bin with random tiles that don't
  // already make a line. The goal is to clear all of them.
  function prefill() {
    const n = Math.min(14, 7 + Math.floor(S.level / 2));
    for (let a = 0; a < 80; a++) {
      S.grid = [[], [], [], [], []];
      for (let i = 0; i < n; i++) {
        const ok = [0, 1, 2, 3, 4].filter((c) => S.grid[c].length < 3);
        S.grid[ok[(Math.random() * ok.length) | 0]].push((Math.random() * S.ncol) | 0);
      }
      if (!findLines().lines.length) break;
    }
    S.goal = S.grid.reduce((a, c) => a + c.length, 0);
  }

  // Survive and bonus waves run against a clock.
  const timed = () => S.wtype === "survive" || S.wtype === "bonus";

  // Words describing this wave's goal, for the intro banner.
  function goalText() {
    const g = S.goal,
      pl = g > 1 ? "S" : "";
    return {
      rows: "MAKE " + g + " ACROSS LINE" + pl,
      big: "MAKE " + g + " LINE" + pl + " OF 4+",
      survive: "SURVIVE " + g + " SECONDS",
      clearbin: "CLEAR ALL " + g + " TILES",
      bonus: "NO LIVES LOST. GO!",
      lines: "MATCH " + S.goal + " LINES",
      diag: "MAKE " + S.goal + " DIAGONAL" + (S.goal > 1 ? "S" : ""),
      score: "SCORE " + S.goal + " PTS",
      catch: "CATCH " + S.goal + " TILES",
    }[S.wtype];
  }

  // Progress shown in the top bar, e.g. LINES 2/5 or TIME 32.
  function progText() {
    const p = Math.min(S.prog, S.goal);
    if (timed()) return "TIME " + Math.ceil(S.timer);
    return S.wtype === "score"
      ? "NEED " + (S.goal - p)
      : { lines: "LINES ", diag: "DIAG ", catch: "CATCH ", rows: "ACROSS ", big: "BIG ", clearbin: "CLEAR " }[
          S.wtype
        ] +
          p +
          "/" +
          S.goal;
  }

  // End the wave once its goal is met (timed waves end when the clock does).
  function checkGoal() {
    if (S.state === "play" && !timed() && S.prog >= S.goal) levelClear();
  }

  // Add points (these also count towards score waves).
  function addPts(p) {
    S.score += p;
    if (S.wtype === "score") S.prog += p;
  }

  // Start a fresh game from wave 1.
  function newGame() {
    S.level = 1;
    S.score = 0;
    S.lane = 2;
    startLevel();
  }

  // Send a new tile down a lane that isn't busy at the top. About 1 in 12
  // is a flashing wild tile (never more than one in play at once).
  function spawn() {
    const busy = new Set(S.tiles.filter((t) => t.t < 0.3).map((t) => t.lane)),
      free = [0, 1, 2, 3, 4].filter((l) => !busy.has(l));
    if (!free.length) return;
    const bomb = !S.tiles.some((t) => t.col === 7) && !S.stack.includes(7) && Math.random() < 0.08;
    S.tiles.push({
      lane: free[(Math.random() * free.length) | 0],
      col: bomb ? 7 : (Math.random() * S.ncol) | 0,
      t: 0,
      acc: 0,
    });
  }

  // Throw out sparkle particles from a point.
  function burst(x, y, col, n) {
    for (let i = 0; i < n; i++)
      S.fx.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 120,
        vy: -Math.random() * 120,
        life: 0.6,
        col: col === 7 ? (Math.random() * 7) | 0 : col,
      });
  }

  // Can the paddle catch this tile? Includes a short grace period when the
  // paddle has only just left the lane, matching what the player sees.
  function canCatch(tl) {
    return S.stack.length < 5 && (tl.lane === S.lane || (tl.lane === S.prevLane && now - S.laneT < 150));
  }

  // A tile has reached the bottom of the ramp. Catch it now, or let it
  // hang for a moment in case the paddle arrives a split second late.
  function arrive(tl) {
    if (S.state !== "play") {
      tl.dead = true;
      return;
    }
    if (canCatch(tl)) {
      tl.dead = true;
      catchT(tl);
    } else tl.hang = 0.15;
  }

  // Add a caught tile to the paddle.
  function catchT(tl) {
    S.stack.push(tl.col);
    SFX.catch();
    if (S.wtype === "bonus") addPts(50);
    burst(S.px + 15, PY - S.stack.length * 6, tl.col, 4);
    if (S.wtype === "catch") {
      S.prog++;
      checkGoal();
    }
  }

  // A tile was missed. Costs a life, except for wild tiles and bonus rounds.
  // Says PADDLE FULL! when the paddle was underneath but already held 5.
  function missT(tl) {
    if (S.state !== "play") return;
    const full = tl.lane === S.lane && S.stack.length >= 5;
    if (tl.col === 7) {
      S.debris.push({ x: 15 + tl.lane * 30 + 1, y: RB - 4, vy: -50, col: 7 });
      S.pops.push({ x: 15 + tl.lane * 30 + 15, y: RB - 10, s: "LOST IT", c: "#fff", life: 1 });
    } else if (S.wtype === "bonus") {
      S.debris.push({ x: 15 + tl.lane * 30 + 1, y: RB - 4, vy: -50, col: tl.col });
      S.pops.push({ x: 15 + tl.lane * 30 + 15, y: RB - 10, s: "MISS", c: "#b8b0d0", life: 0.8 });
      SFX.buzz();
    } else {
      S.drops++;
      S.debris.push({ x: 15 + tl.lane * 30 + 1, y: RB - 4, vy: -50, col: tl.col });
      SFX.miss();
      S.shake = 0.25;
      S.flash = 0.25;
      S.pops.push({
        x: full ? 90 : 15 + tl.lane * 30 + 15,
        y: RB - 10,
        s: full ? "PADDLE FULL!" : "MISS",
        c: "#ff6060",
        life: 1.2,
      });
      if (S.drops >= S.maxDrops) gameOver();
    }
  }

  // Number of tiles in a bin column, including any still falling into it.
  function colH(c) {
    return S.grid[c].length + S.fallers.filter((f) => f.c === c).length;
  }

  // Move the paddle to a lane, remembering the old one for the grace period.
  function setLane(l) {
    if (l !== S.lane) {
      S.prevLane = S.lane;
      S.laneT = now;
      S.lane = l;
    }
  }

  // Move the paddle one lane left (-1) or right (+1).
  function move(d) {
    setLane(Math.max(0, Math.min(4, S.lane + d)));
  }

  // Drop the paddle's top tile into the bin column below.
  // A wild tile can always be dropped, even onto a full column.
  function drop() {
    if (S.state !== "play") return;
    if (!S.stack.length || (S.stack[S.stack.length - 1] !== 7 && colH(S.lane) >= 5)) {
      SFX.buzz();
      return;
    }
    S.fallers.push({ c: S.lane, col: S.stack.pop(), y: PY, vy: 60 });
    SFX.drop();
  }

  // Throw the paddle's top tile back up the ramp.
  function toss() {
    if (S.state !== "play" || !S.stack.length) return;
    S.tiles.push({ lane: S.lane, col: S.stack.pop(), t: 0.3, acc: 0 });
    SFX.toss();
  }

  // Screen y of a bin row (row 0 is the bottom).
  const rowY = (r) => BY + (4 - r) * CH + 1;

  // Find every run of 3 or more same-coloured tiles across (h), down (v)
  // or diagonally (d). Returns the lines and a grid marking cells to clear.
  function findLines() {
    const at = (c, r) => (c >= 0 && c < 5 && r >= 0 && r < 5 ? S.grid[c][r] : undefined),
      mark = [[], [], [], [], []],
      lines = [];
    const dirs = [
      [1, 0, "h"],
      [0, 1, "v"],
      [1, 1, "d"],
      [1, -1, "d"],
    ];
    for (let c = 0; c < 5; c++)
      for (let r = 0; r < 5; r++) {
        const v = at(c, r);
        if (v == null) continue;
        for (const [dc, dr, k] of dirs) {
          if (at(c - dc, r - dr) === v) continue;
          let n = 1;
          while (at(c + dc * n, r + dr * n) === v) n++;
          if (n >= 3) {
            lines.push({ k, n, c, r });
            for (let i = 0; i < n; i++) mark[c + dc * i][r + dr * i] = 1;
          }
        }
      }
    return { lines, mark };
  }

  // Clear every line, score it, let tiles settle, then repeat for chain
  // reactions. Also counts progress towards the current wave's goal.
  function resolve() {
    let chain = 0;
    for (;;) {
      const { lines, mark } = findLines();
      if (!lines.length) break;
      chain++;
      let pts = 0;
      // Base points: down 100, across 250, diagonal 500, more for longer
      // lines and chain reactions. Gold-colour lines score triple.
      for (const l of lines)
        pts += { h: 250, v: 100, d: 500 }[l.k] * (l.n - 2) * chain * (S.grid[l.c][l.r] === S.gold ? 3 : 1);
      if (lines.some((l) => S.grid[l.c][l.r] === S.gold))
        S.pops.push({ x: 90, y: BY - 44, s: "GOLD x3!", c: "#ffd23a", life: 1.2 });
      addPts(pts);
      if (S.wildRes && chain === 1 && ["lines", "rows", "diag", "big"].includes(S.wtype)) S.prog += 1;
      else if (S.wtype === "lines") S.prog += lines.length;
      else if (S.wtype === "diag") S.prog += lines.filter((l) => l.k === "d").length;
      else if (S.wtype === "rows") S.prog += lines.filter((l) => l.k === "h").length;
      else if (S.wtype === "big") S.prog += lines.filter((l) => l.n >= 4).length;
      else if (S.wtype === "clearbin") for (const m of mark) S.prog += m.filter(Boolean).length;
      for (let c = 0; c < 5; c++)
        for (let r = 0; r < 5; r++) if (mark[c][r]) burst(15 + c * 30 + 15, rowY(r) + 10, S.grid[c][r], 6);
      const l0 = lines[0];
      S.pops.push({ x: 15 + l0.c * 30 + 15, y: rowY(l0.r), s: "+" + pts, c: "#ffd23a", life: 1.2 });
      if (lines.some((l) => l.k === "d"))
        S.pops.push({ x: 90, y: BY - 14, s: "DIAGONAL!", c: "#c45cff", life: 1.2 });
      if (chain > 1) S.pops.push({ x: 90, y: BY - 24, s: "CHAIN x" + chain, c: "#3ad35a", life: 1.2 });
      for (let c = 0; c < 5; c++) S.grid[c] = S.grid[c].filter((v, r) => !mark[c][r]);
      SFX.match(chain);
    }
    checkGoal();
  }

  // A wild tile has landed. Try each colour: if one completes a line through
  // this spot, become that colour and clear the line (counts as one
  // completion). Returns false if no colour works.
  function wild(c) {
    const r = S.grid[c].length;
    if (r >= 5) return false;
    let best = -1,
      bn = 0;
    for (let k = 0; k < 7; k++) {
      S.grid[c].push(k);
      const { mark } = findLines();
      S.grid[c].pop();
      if (mark[c][r]) {
        const n = mark.reduce((a, m) => a + m.filter(Boolean).length, 0);
        if (n > bn) {
          bn = n;
          best = k;
        }
      }
    }
    if (best < 0) return false;
    S.grid[c].push(best);
    S.wflash = 0.3;
    S.pops.push({ x: 90, y: BY - 34, s: "WILD!", c: "#fff", life: 1.3 });
    S.wildRes = true;
    resolve();
    S.wildRes = false;
    // Completing a line with a wild tile earns a 1,000 point bonus.
    addPts(1000);
    S.pops.push({ x: 90, y: BY - 54, s: "WILD BONUS +1000", c: "#fff", life: 1.4 });
    SFX.clear();
    checkGoal();
    return true;
  }

  // Clear a whole bin column (a wild tile that couldn't complete a line).
  function zap(c) {
    const n = S.grid[c].length,
      pts = n ? n * 200 : 100;
    for (let r = 0; r < n; r++) burst(15 + c * 30 + 15, rowY(r) + 10, S.grid[c][r], 8);
    S.grid[c] = [];
    addPts(pts);
    if (S.wtype === "clearbin") S.prog += n;
    S.wflash = 0.35;
    S.shake = 0.15;
    S.pops.push({ x: 90, y: BY - 14, s: n ? "COLUMN CLEAR!" : "ZAP!", c: "#fff", life: 1.3 });
    S.pops.push({ x: 15 + c * 30 + 15, y: BY + 40, s: "+" + pts, c: "#ffd23a", life: 1.2 });
    SFX.zap();
    checkGoal();
  }

  // Wave complete: bonus points for every unused life.
  function levelClear() {
    S.state = "clear";
    S.stateT = 0;
    S.bonus = (S.maxDrops - S.drops) * 1000 + S.level * 500;
    S.score += S.bonus;
    SFX.clear();
  }

  // Out of lives. Check whether the score makes the top 10.
  function gameOver() {
    S.state = "over";
    S.stateT = 0;
    S.qual = qualifies(S.score);
    S.newHi = S.score > hi;
    if (S.newHi) {
      hi = S.score;
      try {
        localStorage.setItem("tt_hi", hi);
      } catch (e) {}
    }
    SFX.over();
  }

  // Start entering initials for the high score table.
  function startEntry() {
    S.state = "entry";
    S.stateT = 0;
    S.ini = lastName.split("");
    S.pos = 0;
  }

  // Save the new high score, then show the table on the title screen.
  function saveEntry() {
    const n = S.ini.join("");
    lastName = n;
    table.push({ n, s: S.score, w: S.level });
    table.sort((a, b) => b.s - a.s);
    table = table.slice(0, 10);
    S.rank = table.findIndex((e) => e.n === n && e.s === S.score);
    hi = Math.max(hi, table[0].s);
    try {
      localStorage.setItem("tf_scores", JSON.stringify(table));
      localStorage.setItem("tf_name", n);
    } catch (e) {}
    S.state = "title";
    S.stateT = 9;
    S.level = 1;
    buildBg();
    SFX.clear();
  }

  // Initials controls: left/right change the letter, DROP moves on, TOSS goes back.
  function entryAct(a) {
    const i = ABC.indexOf(S.ini[S.pos]);
    if (a === "L") S.ini[S.pos] = ABC[(i + 25) % 26];
    else if (a === "R") S.ini[S.pos] = ABC[(i + 1) % 26];
    else if (a === "T") {
      if (S.pos > 0) S.pos--;
    } else {
      S.pos++;
      if (S.pos > 2) saveEntry();
    }
    SFX.catch();
  }

  // Pause and resume (the music pauses too).
  function pause() {
    if (S.state === "play" || S.state === "intro") {
      S.prev = S.state;
      S.state = "pause";
      if (ac) ac.suspend();
    }
  }
  function resume() {
    if (S.state !== "pause") return;
    S.state = S.prev;
    if (ac) ac.resume();
  }

  // Move the game forward by dt seconds. Runs every frame: effects, screen
  // changes, new tiles, tiles on the ramp, tiles falling into the bin, timers.
  function update(dt) {
    const ms = dt * 1000;
    S.stateT += dt;
    S.px += (15 + S.lane * 30 - S.px) * Math.min(1, dt * 22);
    S.shake = Math.max(0, S.shake - dt);
    S.flash = Math.max(0, S.flash - dt * 1.5);
    S.wflash = Math.max(0, (S.wflash || 0) - dt * 1.5);
    if (S.toast) {
      S.toast.t -= dt;
      if (S.toast.t <= 0) S.toast = null;
    }
    for (const f of S.fx) {
      f.vy += 300 * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.life -= dt;
    }
    S.fx = S.fx.filter((f) => f.life > 0);
    for (const p of S.pops) {
      p.y -= 18 * dt;
      p.life -= dt;
    }
    S.pops = S.pops.filter((p) => p.life > 0);
    for (const d of S.debris) {
      d.vy += 600 * dt;
      d.y += d.vy * dt;
    }
    S.debris = S.debris.filter((d) => d.y < H);
    if (S.state === "boot" && !S.booted) S.stateT = 0;
    if (S.state === "boot" && S.stateT > 5) {
      S.state = "title";
      S.stateT = 0;
      S.armed = true;
    }
    if (S.state === "intro" && S.stateT > 3.2) {
      S.state = "play";
      S.stateT = 0;
    }
    if (S.state === "clear" && S.stateT > 3) {
      S.level++;
      startLevel();
    }
    if (S.state === "over" && S.qual && S.stateT > 2.2) startEntry();
    if (S.state !== "play") return;
    S.scroll = (S.scroll + (dt * 1000) / (S.stepMs * STEPS)) % 1;
    S.spawnT -= ms;
    if (S.spawnT <= 0) {
      spawn();
      S.spawnT =
        S.spawnMs *
        (S.wtype === "bonus" ? 0.45 : S.wtype === "survive" ? 0.8 : 1) *
        (0.75 + Math.random() * 0.5);
    }
    if (timed()) {
      S.timer -= dt;
      S.prog = S.goal - Math.max(0, S.timer);
      if (S.timer <= 0) {
        S.timer = 0;
        levelClear();
        return;
      }
    }
    for (const tl of S.tiles) {
      if (tl.dead) continue;
      if (tl.hang != null) {
        tl.hang -= dt;
        if (canCatch(tl)) {
          tl.dead = true;
          catchT(tl);
        } else if (tl.hang <= 0) {
          tl.dead = true;
          missT(tl);
        }
        continue;
      }
      tl.acc += ms;
      while (tl.acc >= S.stepMs && !tl.dead && tl.hang == null) {
        tl.acc -= S.stepMs;
        tl.t += 1 / STEPS;
        if (tl.t >= 1 - 1e-6) {
          tl.t = 1;
          tl.acc = 0;
          arrive(tl);
        }
      }
    }
    S.tiles = S.tiles.filter((t) => !t.dead);
    for (const f of S.fallers) {
      f.vy += 900 * dt;
      f.y += f.vy * dt;
      const ty = rowY(S.grid[f.c].length);
      const ty2 = rowY(Math.min(4, S.grid[f.c].length));
      if (f.y >= (f.col === 7 ? ty2 : ty) && !f.dead) {
        f.dead = true;
        if (f.col === 7) {
          if (!wild(f.c)) zap(f.c);
          continue;
        }
        if (S.grid[f.c].length < 5) S.grid[f.c].push(f.col);
        burst(15 + f.c * 30 + 15, ty + CH - 2, f.col, 3);
      }
    }
    if (S.fallers.some((f) => f.dead)) {
      S.fallers = S.fallers.filter((f) => !f.dead);
      resolve();
    }
  }

  // ======================================================================
  // 7. DRAWING EACH FRAME
  // ======================================================================
  // x position of lane edge e (0-5) at ramp position t (0 top, 1 bottom).
  // The ramp widens towards the bottom to give a sense of perspective.
  const ex = (e, t) => 90 + (e - 2.5) * (18 + 12 * t);

  // Fill a polygon on the game canvas.
  function poly(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.fill();
  }

  // Draw the playfield: ramp, tumbling tiles, bin, paddle, effects, top bar.
  function drawPlay() {
    const T = TH[S.theme];
    ctx.fillStyle = "rgba(8,6,20,.74)";
    poly([
      [ex(0, 0), RT],
      [ex(5, 0), RT],
      [ex(5, 1), RB],
      [ex(0, 1), RB],
    ]);
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = T.acc;
    poly([
      [ex(S.lane, 0), RT],
      [ex(S.lane + 1, 0), RT],
      [ex(S.lane + 1, 1), RB],
      [ex(S.lane, 1), RB],
    ]);
    for (let k = 0; k < 10; k++) {
      const tt = (k / 10 + S.scroll) % 1,
        y = Math.round(RT + tt * (RB - RT));
      ctx.fillRect(ex(0, tt), y, ex(5, tt) - ex(0, tt), 1);
    }
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = T.acc;
    ctx.lineWidth = 1;
    for (let e = 0; e <= 5; e++) {
      ctx.beginPath();
      ctx.moveTo(ex(e, 0), RT);
      ctx.lineTo(ex(e, 1), RB);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = T.acc;
    ctx.fillRect(Math.round(ex(0, 0)) - 2, RT - 3, Math.round(ex(5, 0) - ex(0, 0)) + 4, 2);
    ctx.fillRect(13, RB, 154, 2);
    for (const tl of S.tiles) {
      const p = tl.acc / S.stepMs,
        tt = Math.min(1, tl.t + p / STEPS),
        lw = 18 + 12 * tt,
        cx = 90 + (tl.lane - 2) * lw,
        y = RT + tt * (RB - RT),
        bh = 5 + tt * 7,
        c = Math.cos(p * Math.PI),
        hh = Math.max(1, bh * Math.abs(c));
      tile(cx - lw / 2 + 1.5, y - hh, lw - 3, hh, tl.col, c < 0);
    }
    ctx.fillStyle = "rgba(8,6,20,.8)";
    ctx.fillRect(14, BY - 1, 152, CH * 5 + 2);
    ctx.strokeStyle = T.acc;
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(13.5, BY - 1.5, 153, CH * 5 + 3);
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = T.acc;
    for (let c = 1; c < 5; c++) ctx.fillRect(15 + c * 30, BY, 1, CH * 5);
    ctx.globalAlpha = 1;
    for (let c = 0; c < 5; c++)
      for (let r = 0; r < S.grid[c].length; r++) tile(15 + c * 30 + 1, rowY(r), 28, CH - 2, S.grid[c][r]);
    for (const f of S.fallers) tile(15 + f.c * 30 + 1, f.y, 28, CH - 2, f.col);
    const px = Math.round(S.px);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#fff";
    for (let y = PY + 6; y < BY - 1; y += 3) ctx.fillRect(px + 14, y, 2, 1);
    ctx.globalAlpha = 1;
    for (let i = 0; i < S.stack.length; i++) tile(px + 1, PY - (i + 1) * 6, 28, 6, S.stack[i]);
    if (S.stack.length >= 5 && S.state === "play" && blink()) txt("FULL", px + 15, PY - 40, "#ff6060");
    ctx.fillStyle = "#c8c8d8";
    ctx.fillRect(px, PY, 30, 5);
    ctx.fillStyle = "#fff";
    ctx.fillRect(px, PY, 30, 1);
    ctx.fillStyle = "#5a5a74";
    ctx.fillRect(px, PY + 4, 30, 1);
    ctx.fillStyle = "#ffd23a";
    ctx.fillRect(px + 13, PY + 1, 4, 3);
    for (const d of S.debris) tile(d.x, d.y, 28, 6, d.col);
    for (const f of S.fx) {
      ctx.fillStyle = PAL[f.col].hi;
      ctx.fillRect(f.x | 0, f.y | 0, 2, 2);
    }
    for (const p of S.pops) txt(p.s, p.x, p.y | 0, p.c);
    ctx.fillStyle = "rgba(0,0,0,.62)";
    ctx.fillRect(0, 0, W, 30);
    txt(pad6(S.score), 4, 4, "#fff", "left");
    txt("WAVE " + S.level, 90, 4, "#ffd23a");
    for (let i = 0; i < S.maxDrops; i++) {
      ctx.fillStyle = i < S.drops ? "#e8403c" : "#4a4a66";
      ctx.fillRect(176 - (S.maxDrops - i) * 7, 4, 5, 7);
    }
    txt(progText(), 4, 17, "#9eefff", "left");
    // On score waves, show the gold colour next to the target.
    if (S.gold >= 0 && S.state !== "title") tile(84, 17, 12, 8, S.gold);
    txt("HI " + pad6(Math.max(hi, S.score)), 176, 17, "#b8b0d0", "right");
  }

  // Dark strip behind on-screen messages.
  function banner(y, h) {
    ctx.fillStyle = "rgba(0,0,0,.6)";
    ctx.fillRect(0, y, W, h);
  }

  // Alternates true/false about twice a second, for flashing text.
  const blink = () => Math.floor(now / 450) % 2 === 0;

  // Colours of the tape-loading stripes.
  const TAPE = ["#02140d", "#0b5a36", "#1fa060", "#5ee6a0", "#c8ffe0", "#08502e"];

  // Draw the AA Software emerald with its glow and sparkles.
  function gem(t) {
    const P = (c, pts) => {
      ctx.fillStyle = c;
      poly(pts);
    };
    ctx.globalAlpha = 0.25 + 0.1 * Math.sin(t * 4);
    ctx.fillStyle = "#1fa060";
    for (let r = 34; r > 24; r -= 4) {
      ctx.fillRect(90 - r, 92 - r * 0.75, r * 2, r * 1.5);
    }
    ctx.globalAlpha = 1;
    P("#03261a", [
      [74, 74],
      [106, 74],
      [114, 82],
      [114, 102],
      [106, 110],
      [74, 110],
      [66, 102],
      [66, 82],
    ]);
    P("#14a05a", [
      [75, 76],
      [105, 76],
      [112, 83],
      [112, 101],
      [105, 108],
      [75, 108],
      [68, 101],
      [68, 83],
    ]);
    P("#5ee6a0", [
      [75, 76],
      [105, 76],
      [99, 85],
      [81, 85],
    ]);
    P("#22b86a", [
      [68, 83],
      [68, 101],
      [78, 96],
      [78, 88],
    ]);
    P("#0c7a44", [
      [112, 83],
      [112, 101],
      [102, 96],
      [102, 88],
    ]);
    P("#08502e", [
      [75, 108],
      [105, 108],
      [99, 99],
      [81, 99],
    ]);
    P("#9cf6c8", [
      [81, 85],
      [99, 85],
      [102, 88],
      [102, 96],
      [99, 99],
      [81, 99],
      [78, 96],
      [78, 88],
    ]);
    ctx.fillStyle = "#e8fff2";
    ctx.fillRect(83, 87, 6, 1);
    ctx.fillRect(83, 88, 1, 4);
    const sp = (t * 1.3) % 2;
    if (sp < 0.5) {
      const s = Math.round(3 + sp * 6),
        x = 84,
        y = 86;
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - s, y, s * 2 + 1, 1);
      ctx.fillRect(x, y - s, 1, s * 2 + 1);
    }
    const s2 = (t * 1.3 + 1) % 2;
    if (s2 < 0.4) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(106, 104, 5, 1);
      ctx.fillRect(108, 102, 1, 5);
    }
  }

  // Start-up sequence: TAP TO LOAD, tape-loading stripes, then the
  // AA Software Ltd logo reveal.
  function drawBoot() {
    const t = S.stateT;
    if (!S.booted) {
      ctx.fillStyle = "#02140d";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#04201a";
      for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
      txt("READY.", 8, 12, "#5ee6a0", "left");
      if (blink()) ctx.fillRect(8, 24, 8, 8);
      ctx.fillStyle = "#0b5a36";
      ctx.fillRect(40, 120, 100, 60);
      ctx.fillStyle = "#02140d";
      ctx.fillRect(46, 126, 88, 30);
      ctx.fillStyle = "#1fa060";
      ctx.fillRect(60, 136, 14, 12);
      ctx.fillRect(106, 136, 14, 12);
      ctx.fillStyle = "#5ee6a0";
      ctx.fillRect(66, 140, 2, 4);
      ctx.fillRect(112, 140, 2, 4);
      txt("TAP TO LOAD", 90, 206, blink() ? "#c8ffe0" : "#5ee6a0");
      txt("SOUND ON", 90, 226, "#2e7a56");
      return;
    }
    if (t < 1.6) {
      for (let y = 0; y < H;) {
        const h = (2 + Math.random() * 7) | 0;
        ctx.fillStyle = TAPE[(Math.random() * TAPE.length) | 0];
        ctx.fillRect(0, y, W, h);
        y += h;
      }
      ctx.fillStyle = "#02140d";
      ctx.fillRect(18, 120, 144, 64);
      ctx.fillStyle = "#1fa060";
      ctx.fillRect(18, 120, 144, 2);
      ctx.fillRect(18, 182, 144, 2);
      txt(t < 0.6 ? "SEARCHING" : "LOADING" + ".".repeat(1 + (Math.floor(t * 4) % 3)), 90, 136, "#5ee6a0");
      txt("TILEFALL 64", 90, 156, "#c8ffe0");
      return;
    }
    ctx.fillStyle = "#02140d";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#04201a";
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
    const rev = Math.min(H, ((t - 1.6) / 1.1) * H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, rev);
    ctx.clip();
    gem(t);
    ctx.font = '24px "Press Start 2P", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#03261a";
    ctx.fillText("AA", 93, 123);
    ctx.fillStyle = "#0b5a36";
    ctx.fillText("AA", 92, 122);
    ctx.fillStyle = "#5ee6a0";
    ctx.fillText("AA", 90, 120);
    ctx.fillStyle = "#c8ffe0";
    ctx.fillRect(66, 121, 48, 1);
    txt("SOFTWARE LTD", 90, 154, "#c8ffe0");
    ctx.fillStyle = "#1fa060";
    ctx.fillRect(14, 157, 24, 2);
    ctx.fillRect(142, 157, 24, 2);
    ctx.restore();
    if (rev < H) {
      ctx.fillStyle = "#9cf6c8";
      ctx.fillRect(0, Math.round(rev), W, 2);
    }
    if (t > 3) {
      ctx.globalAlpha = Math.min(1, (t - 3) / 0.5);
      txt("PRESENTS", 90, 186, "#7cf0b0");
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = "#0b3d2e";
    ctx.fillRect(30, 276, 120, 6);
    ctx.fillStyle = "#5ee6a0";
    ctx.fillRect(30, 276, Math.round(120 * Math.min(1, t / 5)), 6);
    if (t > 1) txt("TAP TO SKIP", 90, 296, "#2e7a56");
  }

  // 3x5 block letters for the Tilefall 64 logo (each row is 3 bits).
  const GL = {
    T: [7, 2, 2, 2, 2],
    I: [7, 2, 2, 2, 7],
    L: [4, 4, 4, 4, 7],
    E: [7, 4, 6, 4, 7],
    F: [7, 4, 6, 4, 4],
    A: [2, 5, 7, 5, 5],
    6: [7, 4, 7, 5, 7],
    4: [5, 5, 7, 1, 1],
  };

  // Draw a word in tile blocks that tumble in from above and stack up.
  function logo(word, x0, y0, bs, gap, cols, d0) {
    const t = S.stateT;
    [...word].forEach((ch, i) => {
      const g = GL[ch];
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 3; c++) {
          if (!((g[r] >> (2 - c)) & 1)) continue;
          const x = x0 + i * (bs * 3 + gap) + c * bs,
            ty = y0 + r * bs,
            p = Math.min(1, Math.max(0, (t - d0 - i * 0.08 - (4 - r) * 0.04) / 0.35));
          if (p <= 0) continue;
          const y = ty - (1 - p) * (1 - p) * 140;
          ctx.fillStyle = "rgba(0,0,0,.5)";
          ctx.fillRect(x + 2, Math.round(y) + 2, bs, bs);
          tile(x, y, bs, bs, cols[i % cols.length], p < 1 && p > 0.5);
        }
    });
  }

  // The title screen: logo, then instructions or the high score table.
  function drawTitle() {
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.fillRect(0, 0, W, H);
    logo("TILEFALL", 20, 24, 5, 3, [0, 3, 2, 1, 4, 5, 0, 3], 0.1);
    logo("64", 63, 54, 8, 6, [1, 2], 0.7);
    const sh = (S.stateT * 0.5) % 2;
    if (S.stateT > 1.5 && sh < 0.35) {
      const x = (20 + (sh / 0.35) * 150) | 0;
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.fillRect(x, 24, 2, 70);
    }
    for (let i = 0; i < 5; i++) {
      const p = (now / 420 + i * 0.25) % 1,
        c = Math.cos(p * Math.PI),
        h = Math.max(1, 8 * Math.abs(c));
      tile(28 + i * 26, 106 - h / 2, 22, h, i, c < 0);
    }
    const ph = S.stateT % 15;
    if (table.length && ph >= 9) {
      txt("HIGH SCORES", 90, 120, "#ffd23a");
      table
        .slice(0, 8)
        .forEach((e, i) =>
          txt(
            String(i + 1).padStart(2, " ") + " " + e.n + " " + pad6(e.s),
            90,
            136 + i * 12,
            i === S.rank && blink() ? "#ffd23a" : i === 0 ? "#fff" : "#c8c0e0",
          ),
        );
    } else {
      [
        "CATCH THE TILES,",
        "DROP THEM IN THE BIN.",
        "LINE UP 3 COLOURS",
        "ACROSS, DOWN OR",
        "DIAGONAL TO SCORE.",
      ].forEach((s, i) => txt(s, 90, 120 + i * 11, "#fff"));
      txt("FLASHING TILE: WILD!", 90, 178, ((now / 150) | 0) % 2 ? "#ffd23a" : "#fff");
      txt("OR CLEARS A COLUMN", 90, 189, "#ffd23a");
      ["TAP LANE: MOVE", "TAP AGAIN: DROP", "SWIPE UP: TOSS"].forEach((s, i) =>
        txt(s, 90, 204 + i * 11, "#9eefff"),
      );
    }
    if (blink()) txt(S.armed ? "TAP TO PLAY" : "TAP TO START", 90, 250, "#ffd23a");
    txt("HI " + pad6(hi), 90, 270, "#b8b0d0");
    txt("(C) 2026 AA SOFTWARE", 90, 300, "#5ee6a0");
  }

  // Draw one complete frame, including any message on top.
  function render(dt) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (S.state === "boot") {
      drawBoot();
      return;
    }
    ctx.save();
    if (S.shake > 0)
      ctx.translate(
        Math.round((Math.random() - 0.5) * S.shake * 12),
        Math.round((Math.random() - 0.5) * S.shake * 12),
      );
    ctx.drawImage(bgc, 0, 0);
    drawParts(dt);
    {
      const T = TH[S.theme];
      if (T.live) T.live(pfrac(), now / 1000);
    }
    if (S.state === "title") drawTitle();
    else {
      drawPlay();
      if (S.flash > 0) {
        ctx.fillStyle = "rgba(255,40,40," + S.flash.toFixed(2) + ")";
        ctx.fillRect(0, 0, W, H);
      }
      if (S.wflash > 0) {
        ctx.fillStyle = "rgba(255,255,255," + S.wflash.toFixed(2) + ")";
        ctx.fillRect(0, 0, W, H);
      }
      const T = TH[S.theme];
      if (S.state === "intro") {
        banner(72, 112);
        txt(S.wtype === "bonus" ? "BONUS!" : "WAVE " + S.level, 90, 80, "#ffd23a", "center", 16);
        txt(T.name, 90, 102, T.acc);
        txt(goalText(), 90, 118, "#fff");
        if (S.gold >= 0) {
          tile(50, 130, 14, 9, S.gold);
          txt("SCORES X3", 70, 131, "#ffd23a", "left");
        }
        if (S.stateT > 0.6) {
          ctx.globalAlpha = Math.min(1, (S.stateT - 0.6) * 2);
          txt(T.th[0], 90, 144, "#c8c0e0");
          txt(T.th[1], 90, 156, "#c8c0e0");
          ctx.globalAlpha = 1;
        }
      }
      if (S.state === "clear") {
        banner(80, 78);
        txt("WAVE " + S.level, 90, 88, "#fff");
        txt("CLEAR!", 90, 102, "#3ad35a", "center", 16);
        txt("BONUS " + S.bonus, 90, 128, "#ffd23a");
      }
      if (S.state === "over") {
        banner(70, 110);
        txt("GAME", 90, 80, "#e8403c", "center", 16);
        txt("OVER", 90, 100, "#e8403c", "center", 16);
        txt("SCORE " + pad6(S.score), 90, 126, "#fff");
        if (S.newHi) txt("NEW HIGH SCORE!", 90, 142, "#ffd23a");
        if (S.stateT > 1 && blink())
          txt(S.qual ? "TAP TO SAVE SCORE" : "TAP TO CONTINUE", 90, 160, "#9eefff");
      }
      if (S.state === "entry") {
        banner(60, 170);
        txt("NEW HIGH SCORE!", 90, 70, "#ffd23a");
        txt(pad6(S.score), 90, 86, "#fff");
        txt("ENTER YOUR NAME", 90, 106, "#9eefff");
        for (let i = 0; i < 3; i++) {
          const x = 58 + i * 32;
          txt(S.ini[i], x, 130, i === S.pos ? "#fff" : "#5ee6a0", "center", 16);
          if (i === S.pos && blink()) {
            ctx.fillStyle = "#ffd23a";
            ctx.fillRect(x - 9, 150, 18, 3);
          }
        }
        txt("< > CHANGE", 90, 170, "#b8b0d0");
        txt("DROP = NEXT", 90, 184, "#b8b0d0");
        txt("TOSS = BACK", 90, 198, "#b8b0d0");
        txt("TAP TO CONFIRM", 90, 214, "#ffd23a");
      }
      if (S.state === "pause") {
        banner(100, 56);
        txt("PAUSED", 90, 110, "#fff", "center", 16);
        txt("TAP TO RESUME", 90, 134, "#9eefff");
      }
    }
    if (S.toast) txt(S.toast.s, 90, S.state === "title" ? 8 : 40, "#fff");
    ctx.restore();
  }

  // The main loop: update, then draw, about 60 times a second.
  let last = performance.now();
  function loop(t) {
    now = t;
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    if (S.state !== "pause") update(dt);
    render(S.state === "pause" ? 0 : dt);
    requestAnimationFrame(loop);
  }

  // ======================================================================
  // 8. CONTROLS, SHARING AND SCREEN LAYOUT
  // ======================================================================
  // Handle a game action for whatever screen is showing.
  //   L / R move, D drop, T toss, tap = start or continue.
  function act(a) {
    if (S.state === "boot") {
      if (!S.booted) {
        S.booted = true;
        S.stateT = 0;
        identAudio();
        return;
      }
      if (S.stateT > 1) {
        S.state = "title";
        S.stateT = 0;
        S.armed = true;
      }
      return;
    }
    if (S.state === "title") {
      if (!S.armed) {
        S.armed = true;
        return;
      }
      newGame();
      return;
    }
    if (S.state === "over") {
      if (S.stateT < 1) return;
      if (S.qual) {
        startEntry();
        return;
      }
      S.state = "title";
      S.stateT = 0;
      S.level = 1;
      buildBg();
      return;
    }
    if (S.state === "entry") {
      entryAct(a);
      return;
    }
    if (S.state === "pause") {
      resume();
      return;
    }
    if (S.state === "clear") return;
    if (a === "L") move(-1);
    else if (a === "R") move(1);
    else if (a === "D") drop();
    else if (a === "T") toss();
  }

  // Button handler that fires on touch-down for an instant response.
  const on = (id, f) =>
    document.getElementById(id).addEventListener("pointerdown", (e) => {
      e.preventDefault();
      unlock();
      f();
    });
  on("bL", () => act("L"));
  on("bR", () => act("R"));
  on("bDrop", () => act("D"));
  on("bToss", () => act("T"));

  // Header buttons: music on/off, change scene, pause.
  const bMus = document.getElementById("bMus"),
    bPause = document.getElementById("bPause");
  const musLabel = () => {
    bMus.textContent = musicOn ? "MUSIC ON" : "MUSIC OFF";
  };
  musLabel();
  on("bMus", () => {
    musicOn = !musicOn;
    musLabel();
    try {
      localStorage.setItem("tt_mus", musicOn ? "1" : "0");
    } catch (e) {}
    if (mGain) mGain.gain.setTargetAtTime(musicOn ? 0.3 : 0, ac.currentTime, 0.02);
  });
  on("bBg", () => {
    S.bgOff++;
    buildBg();
    S.toast = { s: TH[S.theme].name, t: 1.5 };
  });
  on("bPause", () => {
    if (S.state === "pause") resume();
    else pause();
    bPause.textContent = S.state === "pause" ? "PLAY" : "PAUSE";
  });

  // SHARING
  // The link to share: the page's own address when it's hosted (GitHub,
  // your website), or the claude.ai link when it's running inside Claude.
  const ART_URL = "https://claude.ai/artifact/APjsP2pG7mSFFf8iwyZbGp";
  const inFrame = (() => {
    try {
      return window.top !== window;
    } catch (e) {
      return true;
    }
  })();
  const shareUrl = () =>
    inFrame || !/^https?:$/.test(location.protocol) ? ART_URL : location.href.split("#")[0];

  // The share panel: QR code, copy link, send, install.
  const $ = (id) => document.getElementById(id),
    shareEl = $("share"),
    bSend = $("bSend"),
    bCopy = $("bCopy");
  $("bShare").addEventListener("click", () => {
    pause();
    bPause.textContent = S.state === "pause" ? "PLAY" : "PAUSE";
    const u = shareUrl();
    $("surl").textContent = u;
    try {
      const q = qrcode(0, "M");
      q.addData(u);
      q.make();
      $("qr").innerHTML = q.createSvgTag(4, 2);
      $("qr").hidden = false;
    } catch (e) {
      $("qr").hidden = true;
    }
    bSend.hidden = !(navigator.share && !inFrame);
    bCopy.textContent = "COPY LINK";
    bInstall.hidden = standalone();
    itext.hidden = true;
    shareEl.hidden = false;
    bCopy.focus();
  });

  // Copy the link; if the clipboard is blocked, select the text instead.
  bCopy.addEventListener("click", () => {
    const u = shareUrl();
    const sel = () => {
      const r = document.createRange();
      r.selectNodeContents($("surl"));
      const w = getSelection();
      w.removeAllRanges();
      w.addRange(r);
      bCopy.textContent = "SELECTED";
    };
    try {
      navigator.clipboard.writeText(u).then(() => {
        bCopy.textContent = "COPIED!";
      }, sel);
    } catch (e) {
      sel();
    }
  });

  // Open the phone's own share sheet (WhatsApp, Messages, email...).
  bSend.addEventListener("click", () => {
    try {
      navigator
        .share({ title: "Tilefall 64", text: "Play Tilefall 64 by AA Software Ltd!", url: shareUrl() })
        .catch(() => {});
    } catch (e) {}
  });

  // INSTALLING
  // Android/Chrome lets us show its install prompt from our own button.
  // iPhone needs Share > Add to Home Screen, so we explain that instead.
  let dip = null;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    dip = e;
  });

  // Is the game already running as an installed app?
  const standalone = () => {
    try {
      return (
        matchMedia("(display-mode: standalone)").matches ||
        matchMedia("(display-mode: fullscreen)").matches ||
        navigator.standalone === true
      );
    } catch (e) {
      return false;
    }
  };
  const bInstall = $("bInstall"),
    itext = $("itext");
  bInstall.addEventListener("click", () => {
    if (dip) {
      dip.prompt();
      dip.userChoice &&
        dip.userChoice.then(() => {
          dip = null;
        });
      return;
    }
    const ios =
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    itext.textContent =
      (inFrame ? "OPEN THE LINK IN " + (ios ? "SAFARI" : "CHROME") + " FIRST. THEN " : "") +
      (ios
        ? "TAP THE SHARE ICON, THEN ADD TO HOME SCREEN."
        : "TAP THE BROWSER MENU, THEN INSTALL APP OR ADD TO HOME SCREEN.");
    itext.hidden = false;
  });
  $("bClose").addEventListener("click", () => {
    shareEl.hidden = true;
  });

  // Escape closes the share panel.
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") shareEl.hidden = true;
  });

  // TOUCH CONTROLS ON THE GAME SCREEN
  // Tap a lane to move there, tap the same lane again to drop,
  // swipe up to toss, swipe left/right to move one lane.
  let ps = null;
  cv.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    unlock();
    ps = { x: e.clientX, y: e.clientY };
  });
  cv.addEventListener("pointerup", (e) => {
    if (!ps) return;
    const dx = e.clientX - ps.x,
      dy = e.clientY - ps.y;
    ps = null;
    if (S.state === "entry") {
      if (Math.abs(dx) > 25 && Math.abs(dx) > Math.abs(dy)) act(dx < 0 ? "L" : "R");
      else if (dy < -30) act("R");
      else if (dy > 30) act("L");
      else act("D");
      return;
    }
    if (S.state !== "play" && S.state !== "intro") {
      act("tap");
      bPause.textContent = "PAUSE";
      return;
    }
    if (dy < -30 && Math.abs(dy) > Math.abs(dx)) {
      act("T");
      return;
    }
    if (Math.abs(dx) > 25 && Math.abs(dx) > Math.abs(dy)) {
      act(dx < 0 ? "L" : "R");
      return;
    }
    const r = cv.getBoundingClientRect(),
      ix = ((e.clientX - r.left) / r.width) * W,
      l = Math.max(0, Math.min(4, Math.floor((ix - 15) / 30)));
    if (l === S.lane) act("D");
    else setLane(l);
  });

  // Keyboard controls: arrows move, Space/Down drop, Up toss, P pause,
  // letters type initials.
  addEventListener("keydown", (e) => {
    const k = { ArrowLeft: "L", ArrowRight: "R", ArrowDown: "D", " ": "D", ArrowUp: "T", Enter: "tap" }[
      e.key
    ];
    if (S.state === "entry" && /^[a-z]$/i.test(e.key)) {
      S.ini[S.pos] = e.key.toUpperCase();
      act("D");
      return;
    }
    if (S.state === "entry" && e.key === "Backspace") {
      act("T");
      return;
    }
    if (e.key === "p" || e.key === "P") {
      if (S.state === "pause") resume();
      else pause();
      return;
    }
    if (k) {
      e.preventDefault();
      unlock();
      act(k);
    }
  });

  // Pause automatically if the player switches to another app.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pause();
      bPause.textContent = "PLAY";
    }
  });

  // Scale the 180x320 canvas to fit the screen, in whole or half steps
  // where possible so the pixels stay crisp.
  const scr = document.getElementById("screen"),
    wrap = document.getElementById("wrap");
  function fit() {
    const r = scr.getBoundingClientRect();
    let s = Math.min(r.width / W, r.height / H);
    if (s >= 2) s = Math.floor(s * 4) / 4;
    s = Math.max(0.5, s);
    wrap.style.width = Math.floor(W * s) + "px";
    wrap.style.height = Math.floor(H * s) + "px";
  }
  const ro = new ResizeObserver(fit);
  ro.observe(scr);
  fit();
  ctx.imageSmoothingEnabled = false;
  buildBg();
  if (document.fonts && document.fonts.load) document.fonts.load('8px "Press Start 2P"').catch(() => {});
  // Start the game loop.
  requestAnimationFrame(loop);
}
