// Wide prefill GEMM (candidate B in docs/research/prefill-profile-2026-09.md): a classic
// shared-memory tiled GEMM for prefill ubatches of 64..512 token columns, used only by the
// opt-in wide prefill path (engine option prefillUbatch, engine/qwen35.js _encodeLayerWide).
//
// Tile: BM weight rows x BN token columns per workgroup, (BM/TM) x (BN/TN) threads, each owning
// a TM x TN register block. Per K stage (KS = 32 * KB values, one or two quant blocks) the
// workgroup dequantizes the weight tile ONCE into shared memory (k-major, vec4 over 4 rows) and
// stages the activation tile (k-major, vec4 over 4 columns), then every thread runs KS fully
// unrolled rank-1 updates. Each weight is dequantized once per BN columns (the 16-column
// row-stationary GEMM in gemm.js re-expands nibbles per 16 columns).
//
// Weights: the engine's repacked Q4_0 / Q8_0 layout (per row nb = dIn / 32 blocks of vec4<u32>,
// two vec4 per block for Q8_0; f16 scales paired in u32). K-quant tensors are converted to Q8_0
// at load (engine/gguf.js), so Q4_0 + Q8_0 cover every quantized projection of both models.
// Activations: read straight from the engine's column-strided layout x[col][xs4 vec4]
// (no transpose kernel). Output: y[col * ys + row] (= or += with _acc: the residual add).
//
// Summation order: one f32 accumulator per (row, column), k ascending 0..dIn-1, no split-K.
// Deterministic and independent of the tile position, but a different order than the GEMV and the
// 16-column GEMM, so wide prefill is prefill-tolerance, not bit-identical, and stays opt-in.
//
// Bindings reuse the matvec_q4_coop_b layout (qs, sc, x, y, shape) so the engine binds it like
// any batched op. js = true emits the kernel body as a JavaScript generator with the same index
// math for the CPU check in tests/unit/gemm_wide_test.js (workgroupBarrier() becomes a yield).
import { wgslToJs } from "./moe.js";

export const WIDE_TILE_DEFAULT = Object.freeze({ BM: 64, BN: 64, TM: 4, TN: 4 });

// Resolve a tile config against a workgroup-memory budget (bytes). KB (quant blocks per K stage)
// defaults to 1: on GB10 the 64x64 tile runs the 27B prefill at 90 tok/s with KB 1 vs 77 with KB 2
// (occupancy; tests/bench_wide_tiles.js). KB 2 stays available when asked for and it fits. Throws on shapes the generator cannot emit.
export function wideTileConfig(opt = {}, wgMem = 16384) {
  const c = { ...WIDE_TILE_DEFAULT, ...(opt || {}) };
  const { BM, BN, TM, TN } = c;
  for (const [k, v] of Object.entries({ BM, BN, TM, TN })) if (!Number.isInteger(v) || v <= 0) throw new Error(`prefillTile.${k} must be a positive integer`);
  if (TM % 4 || TN % 4) throw new Error("prefillTile: TM and TN must be multiples of 4");
  if (BM % TM || BN % TN) throw new Error("prefillTile: TM must divide BM and TN divide BN");
  if (BN % 16) throw new Error("prefillTile: BN must be a multiple of 16");
  c.T = (BM / TM) * (BN / TN);
  if (c.T > 256 || c.T < 32) throw new Error(`prefillTile: ${c.T} threads per workgroup (need 32..256)`);
  const bytes = (KB) => 4 * 32 * KB * (BM + BN);
  if (c.KB == null) c.KB = 1;
  if (!(c.KB === 1 || c.KB === 2) || bytes(c.KB) > wgMem) throw new Error(`prefillTile: ${BM}x${BN} tile needs ${bytes(1)} B of workgroup memory (limit ${wgMem})`);
  c.KS = 32 * c.KB; c.smem = bytes(c.KB);
  return Object.freeze(c);
}

function emit(js, UNPACK) {
  return {
    q4lo: (w) => js ? `q4lo(${w})` : UNPACK ? `(vec4<f32>(unpack4xU8(${w} & 0x0F0F0F0Fu)) - vec4<f32>(8.0))`
      : `(vec4<f32>(f32(${w} & 0xFu), f32((${w} >> 8u) & 0xFu), f32((${w} >> 16u) & 0xFu), f32((${w} >> 24u) & 0xFu)) - vec4<f32>(8.0))`,
    q4hi: (w) => js ? `q4hi(${w})` : UNPACK ? `(vec4<f32>(unpack4xU8((${w} >> 4u) & 0x0F0F0F0Fu)) - vec4<f32>(8.0))`
      : `(vec4<f32>(f32((${w} >> 4u) & 0xFu), f32((${w} >> 12u) & 0xFu), f32((${w} >> 20u) & 0xFu), f32((${w} >> 28u) & 0xFu)) - vec4<f32>(8.0))`,
    i8x4: (w) => js ? `i8x4(${w})` : UNPACK ? `vec4<f32>(unpack4xI8(${w}))`
      : `vec4<f32>(f32(bitcast<i32>(${w} << 24u) >> 24u), f32(bitcast<i32>(${w} << 16u) >> 24u), f32(bitcast<i32>(${w} << 8u) >> 24u), f32(bitcast<i32>(${w}) >> 24u))`,
    scl: (v, s) => js ? `mul4(${v}, ${s})` : `(${v} * ${s})`,
    v4: (a, b, c, d) => js ? `[${a}, ${b}, ${c}, ${d}]` : `vec4<f32>(${a}, ${b}, ${c}, ${d})`,
    zero4: js ? "[0, 0, 0, 0]" : "vec4<f32>(0.0)",
    fma: (acc, s, x) => js ? `${acc} = fma4(${acc}, ${s}, ${x});` : `${acc} += ${s} * ${x};`,
    div: (a, b) => js ? `Math.floor((${a}) / (${b}))` : `((${a}) / (${b}))`,
  };
}

const rng = (n) => Array.from({ length: n }, (_, i) => i);

// One kernel: fmt "q4" | "q8", acc: y += instead of y =. Returns { name, body } (body in WGSL or JS).
export function wideKernel(fmt, acc, c, { js = false, UNPACK = true } = {}) {
  const E = emit(js, UNPACK);
  const { BM, BN, TM, TN, T, KB, KS } = c;
  const TX = BN / TN, BM4 = BM / 4, BN4 = BN / 4;
  const name = `gemm_w_${fmt}${acc ? "_acc" : ""}`;
  // weight staging units: Q4 (row quad, block, word) -> 8 k values of 4 rows; Q8 (row quad, block, half, word) -> 4 k values
  const wUnits = fmt === "q4" ? BM4 * KB * 4 : BM4 * KB * 8, wPer = Math.ceil(wUnits / T);
  // activation staging units: (column quad, k quad) -> 4 vec4 loads, one 4x4 transpose
  const xUnits = BN4 * (KS / 4), xPer = Math.ceil(xUnits / T);
  const R4 = rng(4);
  const wload = (j) => {
    const head = `let li = t + ${j * T}u;`;
    if (fmt === "q4") return `
    { ${head} if (li < ${wUnits}u) {
      let rq = li % ${BM4}u; let rest = ${E.div("li", `${BM4}u`)}; let jj = rest % 4u; let bb = ${E.div("rest", "4u")};
      let blk = kb0 + bb;
      ${R4.map((r) => `let g${r} = min(row0 + rq * 4u + ${r}u, dOut - 1u) * nb + blk; let w${r} = gw_q[g${r}][jj]; let s${r} = unpack2x16float(gw_sc[g${r} >> 1u])[g${r} & 1u];
      let lo${r} = ${E.scl(E.q4lo(`w${r}`), `s${r}`)}; let hi${r} = ${E.scl(E.q4hi(`w${r}`), `s${r}`)};`).join("\n      ")}
      ${R4.map((i) => `gw_W[(bb * 32u + 4u * jj + ${i}u) * ${BM4}u + rq] = ${E.v4(...R4.map((r) => `lo${r}[${i}]`))}; gw_W[(bb * 32u + 16u + 4u * jj + ${i}u) * ${BM4}u + rq] = ${E.v4(...R4.map((r) => `hi${r}[${i}]`))};`).join("\n      ")}
    } }`;
    return `
    { ${head} if (li < ${wUnits}u) {
      let rq = li % ${BM4}u; let rest = ${E.div("li", `${BM4}u`)}; let jj = rest % 4u; let hh = ${E.div("rest", "4u")} % 2u; let bb = ${E.div("rest", "8u")};
      let blk = kb0 + bb;
      ${R4.map((r) => `let g${r} = min(row0 + rq * 4u + ${r}u, dOut - 1u) * nb + blk; let w${r} = gw_q[g${r} * 2u + hh][jj]; let s${r} = unpack2x16float(gw_sc[g${r} >> 1u])[g${r} & 1u];
      let d${r} = ${E.scl(E.i8x4(`w${r}`), `s${r}`)};`).join("\n      ")}
      ${R4.map((i) => `gw_W[(bb * 32u + 16u * hh + 4u * jj + ${i}u) * ${BM4}u + rq] = ${E.v4(...R4.map((r) => `d${r}[${i}]`))};`).join("\n      ")}
    } }`;
  };
  const xload = (j) => `
    { let li = t + ${j * T}u; if (li < ${xUnits}u) {
      let kq = li % ${KS / 4}u; let cq = ${E.div("li", `${KS / 4}u`)};
      ${R4.map((cc) => `let v${cc} = gw_x[(col0 + cq * 4u + ${cc}u) * xs4 + kx0 + kq];`).join(" ")}
      ${R4.map((i) => `gw_X[(kq * 4u + ${i}u) * ${BN4}u + cq] = ${E.v4(...R4.map((cc) => `v${cc}[${i}]`))};`).join("\n      ")}
    } }`;
  const accs = rng(TM).map((r) => rng(TN / 4).map((q) => `a${r}_${q}`));
  const step = (k) => `
    {
      ${rng(TM / 4).map((r4) => `let wv${r4} = gw_W[${k * BM4}u + wb + ${r4}u];`).join(" ")}
      ${rng(TN / 4).map((q) => `let xv${q} = gw_X[${k * BN4}u + xb + ${q}u];`).join(" ")}
      ${rng(TM).map((r) => rng(TN / 4).map((q) => E.fma(accs[r][q], `wv${r >> 2}[${r & 3}]`, `xv${q}`)).join(" ")).join("\n      ")}
    }`;
  const store = rng(TM).map((r) => `
  { let row = row0 + ty * ${TM}u + ${r}u; if (row < dOut) {
    ${rng(TN / 4).map((q) => R4.map((cc) => `gw_y[(col0 + tx * ${TN}u + ${4 * q + cc}u) * ys + row] ${acc ? "+=" : "="} ${accs[r][q]}[${cc}];`).join(" ")).join("\n    ")}
  } }`).join("");
  const body = `
  let S = gw_s; let t = lid.x; let tx = t % ${TX}u; let ty = ${E.div("t", `${TX}u`)};
  let dOut = S.dOut; let nb = ${E.div("S.dIn", "32u")}; let xs4 = S.xs4; let ys = S.ys;
  let row0 = wg.x * ${BM}u; let col0 = wg.y * ${BN}u;
  let wb = ty * ${TM / 4}u; let xb = tx * ${TN / 4}u;
  ${accs.flat().map((a) => `var ${a} = ${E.zero4};`).join(" ")}
  for (var ks: u32 = 0u; ks < nb; ks += ${KB}u) {
    let kb0 = ks; let kx0 = ks * 8u;
    workgroupBarrier();
    ${rng(wPer).map(wload).join("")}
    ${rng(xPer).map(xload).join("")}
    workgroupBarrier();
    ${rng(KS).map(step).join("")}
  }
  ${store}
`;
  return { name, body: js ? wgslToJs(body) : body };
}

// WGSL for the wide path: Q4 / Q8 kernels (= and +=) plus the multi-column SiLU(g) * u.
export function gemmWideWGSL(c, { UNPACK = true } = {}) {
  const kernels = ["q4", "q8"].flatMap((fmt) => [false, true].map((acc) => {
    const k = wideKernel(fmt, acc, c, { UNPACK });
    return `
@compute @workgroup_size(${c.T})
fn ${k.name}(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {${k.body}}`;
  }));
  return /* wgsl */ `
// ---- wide prefill GEMM (BM=${c.BM}, BN=${c.BN}, TM=${c.TM}, TN=${c.TN}, KB=${c.KB}; ${c.smem} B workgroup memory) ----
@group(1) @binding(0) var<storage, read> gw_q: array<vec4<u32>>;
@group(1) @binding(1) var<storage, read> gw_sc: array<u32>;
@group(1) @binding(2) var<storage, read> gw_x: array<vec4<f32>>;
@group(1) @binding(3) var<storage, read_write> gw_y: array<f32>;
@group(1) @binding(4) var<uniform> gw_s: BShape;
var<workgroup> gw_W: array<vec4<f32>, ${c.KS * c.BM / 4}>;
var<workgroup> gw_X: array<vec4<f32>, ${c.KS * c.BN / 4}>;
${kernels.join("\n")}

// SiLU(g) * u over ny columns (n = width, s0 / s1 = column strides of g / u in floats): the same
// expression as silu_mul, one dispatch for a whole ubatch instead of one per column.
@group(1) @binding(0) var<storage, read_write> gws_g: array<f32>;
@group(1) @binding(1) var<storage, read> gws_u: array<f32>;
@group(1) @binding(2) var<uniform> gws_mc: MC;
@compute @workgroup_size(64)
fn silu_mul_w(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= gws_mc.n) { return; }
  let o = gid.y * gws_mc.s0 + i;
  let g = gws_g[o];
  gws_g[o] = (g / (1.0 + exp(-g))) * gws_u[gid.y * gws_mc.s1 + i];
}
`;
}
