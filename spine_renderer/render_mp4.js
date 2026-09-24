import CanvasKitInit from "canvaskit-wasm";

import {
    loadTextureAtlas,
    loadSkeletonData,
    SkeletonDrawable,
    SkeletonRenderer
} from "@esotericsoftware/spine-canvaskit";

import {
    Physics,
    Vector2
} from "@esotericsoftware/spine-core";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PNG } from "pngjs";

// Bisa dioverride lewat env var ROOT/ASSET (dipakai di GitHub Actions).
// Kalau tidak diset, tetap pakai default lama di Termux.
const ROOT = process.env.ROOT || "/storage/emulated/0/pes/spine_renderer";
const ASSET = process.env.ASSET || "/storage/emulated/0/pes/spiker_sara";

// --------------------------------------------------------
// Auto-detect nama file .atlas/.json di dalam folder ASSET,
// jadi tidak perlu hardcode nama karakter (mis. "wingspike_sara").
// Ganti karakter cukup ganti isi folder ASSET, kode tidak perlu diubah.
// Asumsi standar Spine: <nama>.atlas berpasangan dengan <nama>.json.
// --------------------------------------------------------
function findSpineFiles(assetDir) {
    if (!fs.existsSync(assetDir)) {
        throw new Error(`Folder asset tidak ditemukan: ${assetDir}`);
    }

    const entries = fs.readdirSync(assetDir);
    const atlasFile = entries.find(f => f.toLowerCase().endsWith(".atlas"));
    if (!atlasFile) {
        throw new Error(`Tidak ada file .atlas di dalam ${assetDir}`);
    }

    const baseName = atlasFile.slice(0, -".atlas".length);
    let jsonFile = entries.find(f => f === `${baseName}.json`);
    if (!jsonFile) {
        // Fallback: file .json apa saja di folder itu (kalau nama tidak persis sama).
        jsonFile = entries.find(f => f.toLowerCase().endsWith(".json"));
    }
    if (!jsonFile) {
        throw new Error(`Tidak ada file .json (skeleton) di dalam ${assetDir}`);
    }

    console.log(`Asset terdeteksi: ${atlasFile} + ${jsonFile}`);

    return {
        atlas: path.join(assetDir, atlasFile),
        json: path.join(assetDir, jsonFile),
        baseName
    };
}

const SPINE_FILES = findSpineFiles(ASSET);
const ATLAS = SPINE_FILES.atlas;
const JSON_FILE = SPINE_FILES.json;
const OUTPUT = path.join(ROOT, `${SPINE_FILES.baseName}_action_idle.mp4`);

const FPS = Number(process.env.FPS || 60);
const PADDING = Number(process.env.PADDING || 2);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const ACTION_NAME = process.env.ACTION || "action";
const IDLE_NAME = process.env.IDLE || "idle";
// OPSIONAL: animasi ke-3 yang diputar setelah idle. Kosong = nonaktif total.
const EXTRA_NAME = (process.env.EXTRA || "").trim();

// --------------------------------------------------------
// MODE dipakai untuk membagi kerja ke beberapa job GitHub
// Actions yang jalan paralel:
//   single -> perilaku lama: hitung bounds + render + encode
//             langsung jadi 1 mp4 dalam 1 proses (dipakai Termux).
//   bounds -> cuma hitung ukuran kanvas final (finalBounds) dan
//             totalFrames, ditulis ke BOUNDS_FILE (json).
//   frames -> baca BOUNDS_FILE, render frame FRAME_START..FRAME_END
//             (exclusive) jadi file PNG di folder FRAMES_OUT,
//             tanpa encode ke mp4.
// --------------------------------------------------------
const MODE = process.env.MODE || "single";
const BOUNDS_FILE = process.env.BOUNDS_FILE || path.join(ROOT, "bounds.json");
const FRAME_START = Number(process.env.FRAME_START || 0);
const FRAME_END = Number(process.env.FRAME_END || 0);
const FRAMES_OUT = process.env.FRAMES_OUT || path.join(ROOT, "frames");
const THUMBNAIL_OUT = process.env.THUMBNAIL_OUT || path.join(ROOT, `${SPINE_FILES.baseName}_thumbnail.png`);

// --------------------------------------------------------
// 3 mode tambahan buat sharding bounds scan (pass 2) ke beberapa
// job GitHub Actions paralel:
//   bounds-pass1 -> scan vector (murah) semua frame, hasilnya "safe"
//                   canvas + (kalau BOUNDS=game) langsung finalBounds.
//                   Ditulis ke PASS1_FILE.
//   bounds-shard -> baca PASS1_FILE, scan pixel-perfect (mahal) HANYA
//                   utk frame SHARD_START..SHARD_END, hasil partial
//                   union ditulis ke SHARD_FILE.
//   bounds-merge -> baca PASS1_FILE + semua file di SHARDS_DIR,
//                   gabung jadi 1 union, lanjut proses sama seperti
//                   bounds mode lama, tulis BOUNDS_FILE final.
// --------------------------------------------------------
const PASS1_FILE = process.env.PASS1_FILE || path.join(ROOT, "bounds_pass1.json");
const SHARD_FILE = process.env.SHARD_FILE || path.join(ROOT, "bounds_shard.json");
const SHARDS_DIR = process.env.SHARDS_DIR || path.join(ROOT, "bounds_shards");
const SHARD_START = Number(process.env.SHARD_START || 0);
const SHARD_END = Number(process.env.SHARD_END || 0);

// --------------------------------------------------------
// FIX PMA (premultiplied alpha):
// Atlas dengan "pma: true" nyimpen texture PNG yang RGB-nya SUDAH dikali
// alpha. Tapi CanvasKit/Skia nge-decode PNG sebagai straight alpha lalu
// dikali alpha LAGI -> area semi-transparan (glow, flare, rainbow, tepi
// lembut) jadi gelap/menghitam padahal texture aslinya normal.
// Solusi: sebelum dikasih ke CanvasKit, PNG halaman pma di-unpremultiply
// dulu (RGB / alpha), jadi hasil premultiply Skia = nilai texture asli.
// Matikan dengan FIX_PMA=0 kalau perlu.
// --------------------------------------------------------
const FIX_PMA = process.env.FIX_PMA !== "0";

function parseAtlasPmaPages(atlasFile) {
    // Return Map<nama file png (lowercase), boolean pma>
    const map = new Map();
    let text;
    try {
        text = fs.readFileSync(atlasFile, "utf8");
    } catch (err) {
        return map;
    }
    for (const block of text.split(/\r?\n\s*\r?\n/)) {
        const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) continue;
        const pageName = lines[0];
        if (!/\.(png|jpg|jpeg|webp)$/i.test(pageName)) continue;
        const pmaLine = lines.find(l => /^pma\s*:/i.test(l));
        map.set(pageName.toLowerCase(), !!pmaLine && /true/i.test(pmaLine));
    }
    return map;
}

let PMA_PAGES = null;

function unpremultiplyPng(buf) {
    const png = PNG.sync.read(buf);
    const d = png.data;
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        if (a === 0 || a === 255) continue;
        const k = 255 / a;
        d[i] = Math.min(255, Math.round(d[i] * k));
        d[i + 1] = Math.min(255, Math.round(d[i + 1] * k));
        d[i + 2] = Math.min(255, Math.round(d[i + 2] * k));
    }
    return PNG.sync.write(png);
}

function readFile(file) {
    const data = fs.readFileSync(file);
    if (!FIX_PMA || !/\.png$/i.test(file)) return data;

    if (PMA_PAGES === null) PMA_PAGES = parseAtlasPmaPages(ATLAS);
    if (PMA_PAGES.get(path.basename(file).toLowerCase()) !== true) return data;

    try {
        const fixed = unpremultiplyPng(data);
        console.log(`Catatan: ${path.basename(file)} pma:true -> di-unpremultiply biar gak double-premultiply (fix alpha menghitam).`);
        return fixed;
    } catch (err) {
        console.warn(`Peringatan: gagal unpremultiply ${path.basename(file)} (${err.message}), pakai file apa adanya.`);
        return data;
    }
}

// --------------------------------------------------------
// Progress bar helper, biar keliatan jalan + ada estimasi
// waktu selesai (ETA), bukan cuma diam sampai muncul log.
// --------------------------------------------------------
function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

function printProgress(current, total, startTime) {
    const percent = Math.min(100, (current / total) * 100);
    const barLength = 24;
    const filled = Math.round((barLength * percent) / 100);
    const bar = "#".repeat(filled) + "-".repeat(barLength - filled);

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = current / Math.max(elapsed, 0.001);
    const remaining = rate > 0 ? (total - current) / rate : 0;

    const line = `  [${bar}] ${percent.toFixed(1)}%  (${current}/${total})  elapsed ${formatTime(elapsed)}  eta ${formatTime(remaining)}   `;
    process.stdout.write(`\r${line}`);

    if (current >= total) {
        process.stdout.write("\n");
    }
}

function createDrawable(skeletonData) {
    const drawable = new SkeletonDrawable(skeletonData);
    const skeleton = drawable.skeleton;
    skeleton.scaleX = 1;
    skeleton.scaleY = 1;
    skeleton.x = 0;
    skeleton.y = 0;
    return drawable;
}

// BOUNDS menentukan cara canvas/frame render dihitung:
//   dynamic (default) -> perilaku lama: scan semua frame Action+Idle,
//                         union bounds + pixel-perfect crop.
//   game               -> pakai bounds STATIS dari skeleton.json
//                          (x/y/width/height), persis seperti game asli.
const BOUNDS_SOURCE = (process.env.BOUNDS || "dynamic").toLowerCase();

// --------------------------------------------------------
// RENDER_MAX_DIM (opsional): kalau di-set, frame di-render LANGSUNG di
// resolusi ini (sisi terpendek dipatok ke angka ini, proporsional),
// bukan native lalu di-downscale belakangan di ffmpeg. Bounds/crop area
// tetap dihitung dari world units yang sama (akurat), cuma jumlah pixel
// akhirnya yang dikecilkan sejak awal - lebih hemat waktu render & disk
// kalau target output-nya emang jauh lebih kecil dari native.
// Tradeoff: ganti RENDER_MAX_DIM = perlu scan bounds ulang (job "Hitung
// bounds"), karena hasil pixel bergantung skala render-nya.
// --------------------------------------------------------
const RENDER_MAX_DIM = Number(process.env.RENDER_MAX_DIM || 0);

function applyRenderScale(finalBounds) {
    if (!RENDER_MAX_DIM || RENDER_MAX_DIM <= 0) {
        return { ...finalBounds, renderScale: 1 };
    }
    const shortSide = Math.min(finalBounds.width, finalBounds.height);
    const scale = RENDER_MAX_DIM / shortSide;
    const width = Math.max(2, Math.round((finalBounds.width * scale) / 2) * 2);
    const height = Math.max(2, Math.round((finalBounds.height * scale) / 2) * 2);

    console.log("========================================");
    console.log(`RENDER_MAX_DIM aktif: ${RENDER_MAX_DIM}`);
    console.log(`Native (world): ${finalBounds.width}x${finalBounds.height}`);
    console.log(`Render langsung di: ${width}x${height} (scale ${scale.toFixed(6)}x)`);
    console.log("PNG native TIDAK dibuat - langsung di resolusi ini.");
    console.log("========================================");

    return { ...finalBounds, width, height, renderScale: scale };
}

// Nama bone yang mau "dikunci" ke posisi setup pose (rest position) tiap frame,
// buat nutup keyframe translate yang rusak/nyasar tanpa perlu edit file sumber.
// Contoh: LOCK_BONE_TRANSLATE=Root  atau  LOCK_BONE_TRANSLATE=Root,BoneLain
const LOCK_BONES = (process.env.LOCK_BONE_TRANSLATE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function lockBones(skeleton) {
    if (LOCK_BONES.length === 0) return;
    for (const name of LOCK_BONES) {
        const bone = skeleton.findBone(name);
        if (!bone) {
            console.warn(`Catatan: LOCK_BONE_TRANSLATE "${name}" tidak ditemukan di skeleton ini.`);
            continue;
        }
        // balikin ke posisi setup pose (rest), abaikan keyframe translate,
        // scale, DAN rotation apapun yang di-set animasi untuk bone ini di
        // frame sekarang (beberapa bone kontrol punya animasi scale/rotate
        // ekstrem yang tidak mau kita ikuti, bukan cuma translate).
        bone.x = bone.data.x;
        bone.y = bone.data.y;
        bone.scaleX = bone.data.scaleX;
        bone.scaleY = bone.data.scaleY;
        bone.rotation = bone.data.rotation;
    }
}

function resetAndStart(drawable, animationName, loop = false) {
    const skeleton = drawable.skeleton;
    const state = drawable.animationState;

    skeleton.setToSetupPose();
    skeleton.x = 0;
    skeleton.y = 0;
    skeleton.scaleX = 1;
    skeleton.scaleY = 1;

    state.clearTracks();
    state.setAnimation(0, animationName, loop);
    state.apply(skeleton);
    lockBones(skeleton);
    skeleton.updateWorldTransform(Physics.update);
}

function step(drawable, delta) {
    if (delta <= 0) return;

    const skeleton = drawable.skeleton;
    const state = drawable.animationState;

    state.update(delta);
    skeleton.update(delta);
    state.apply(skeleton);
    lockBones(skeleton);
    skeleton.updateWorldTransform(Physics.update);
}

function getBounds(skeleton) {
    const offset = new Vector2();
    const size = new Vector2();
    skeleton.getBounds(offset, size, []);

    return {
        minX: offset.x,
        minY: offset.y,
        maxX: offset.x + size.x,
        maxY: offset.y + size.y
    };
}

function updateUnion(dst, b) {
    dst.minX = Math.min(dst.minX, b.minX);
    dst.minY = Math.min(dst.minY, b.minY);
    dst.maxX = Math.max(dst.maxX, b.maxX);
    dst.maxY = Math.max(dst.maxY, b.maxY);
}

function newUnion() {
    return {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    };
}

function makeSequence(skeletonData) {
    const allAnims = skeletonData.animations || [];
    if (allAnims.length === 0) {
        throw new Error("Tidak ada animasi sama sekali di file skeleton ini.");
    }

    let action = skeletonData.findAnimation(ACTION_NAME);
    if (!action) {
        action = allAnims[0];
        console.log(`Catatan: animation "${ACTION_NAME}" tidak ditemukan.`);
        console.log(`         Pakai animasi pertama yang tersedia sebagai pengganti: "${action.name}".`);
    }

    let idle = skeletonData.findAnimation(IDLE_NAME);
    if (idle && idle.name === action.name) idle = null; // jangan pakai animasi yang sama 2x
    const hasIdle = !!idle;

    if (!hasIdle) {
        console.log(`Catatan: animation "${IDLE_NAME}" tidak ditemukan di file ini (atau sama dengan action).`);
        console.log(`         Video akan berisi "${action.name}" saja (bagian idle dilewati).`);
    }

    let idleDuration = hasIdle ? idle.duration : 0;
    if (hasIdle && process.env.IDLE_DURATION !== undefined && process.env.IDLE_DURATION !== "") {
        const override = Number(process.env.IDLE_DURATION);
        if (Number.isFinite(override) && override >= 0) {
            idleDuration = override;
            const loopCount = idle.duration > 0 ? (override / idle.duration).toFixed(2) : "0";
            console.log(`Catatan: IDLE_DURATION di-set ${override}s (native "${idle.name}" = ${idle.duration.toFixed(3)}s, di-loop ~${loopCount}x).`);
        } else {
            console.log(`Catatan: IDLE_DURATION "${process.env.IDLE_DURATION}" tidak valid, pakai durasi native idle.`);
        }
    }

    // ---- Segmen ke-3 (opsional): EXTRA ----
    let extra = null;
    let extraDuration = 0;
    if (EXTRA_NAME) {
        extra = skeletonData.findAnimation(EXTRA_NAME);
        if (!extra) {
            console.log(`Catatan: animation EXTRA "${EXTRA_NAME}" tidak ditemukan, segmen ke-3 dilewati.`);
        } else {
            extraDuration = extra.duration;
            const raw = process.env.EXTRA_DURATION;
            if (raw !== undefined && raw !== "") {
                const override = Number(raw);
                if (Number.isFinite(override) && override >= 0) {
                    extraDuration = override;
                    console.log(`Catatan: EXTRA_DURATION di-set ${override}s (native "${extra.name}" = ${extra.duration.toFixed(3)}s).`);
                } else {
                    console.log(`Catatan: EXTRA_DURATION "${raw}" tidak valid, pakai durasi native extra.`);
                }
            }
        }
    }
    const hasExtra = !!extra;

    return {
        action,
        idle: hasIdle ? idle : null,
        hasIdle,
        extra,
        hasExtra,
        actionDuration: action.duration,
        idleDuration,
        extraDuration,
        totalDuration: action.duration + idleDuration + extraDuration
    };
}

function totalFramesFor(duration) {
    // Video duration is represented by frames at t = 0 ... (N-1)/FPS.
    // This gives N ~= duration * FPS and does not add an extra frame.
    return Math.max(1, Math.round(duration * FPS));
}

function createSequenceSimulator(skeletonData, sequence) {
    const drawable = createDrawable(skeletonData);
    resetAndStart(drawable, sequence.action.name, false);

    let currentTime = 0;

    // Titik pergantian animasi (urut waktu): action -> idle -> extra.
    // Kalau idle tidak ada, action langsung disambung ke extra (kalau ada).
    // Kalau idle & extra tidak ada, pose terakhir action dipertahankan.
    const boundaries = [];
    if (sequence.hasIdle) {
        boundaries.push({ time: sequence.actionDuration, anim: sequence.idle.name, done: false });
    }
    if (sequence.hasExtra) {
        boundaries.push({
            time: sequence.actionDuration + sequence.idleDuration,
            anim: sequence.extra.name,
            done: false
        });
    }
    if (boundaries.length === 0) {
        // Tidak ada idle/extra: cukup tandai pergantian di akhir action (no-op).
        boundaries.push({ time: sequence.actionDuration, anim: null, done: false });
    }

    function trigger(b) {
        if (b.done) return;
        b.done = true;
        if (b.anim) {
            drawable.animationState.setAnimation(0, b.anim, true);
        }
    }

    function advanceTo(targetTime) {
        if (targetTime < currentTime) {
            throw new Error("Sequence simulator hanya mendukung maju waktu.");
        }

        const EPS = 1e-10;

        while (currentTime + EPS < targetTime) {
            const nextB = boundaries.find(b => !b.done && b.time > currentTime + EPS);
            const stopAt = nextB ? Math.min(targetTime, nextB.time) : targetTime;
            step(drawable, stopAt - currentTime);
            currentTime = stopAt;

            if (nextB && currentTime >= nextB.time - EPS) {
                currentTime = nextB.time;
                trigger(nextB);
            }
        }

        // Boundary yang persis jatuh di targetTime ikut diaktifkan supaya frame
        // di t = boundary sudah memakai animasi berikutnya.
        for (const b of boundaries) {
            if (!b.done && targetTime >= b.time - EPS) {
                currentTime = Math.max(currentTime, b.time);
                trigger(b);
            }
        }
    }

    return { drawable, advanceTo };
}

function makeSafeCanvasSize(worldBounds) {
    const minX = Math.floor(worldBounds.minX) - PADDING;
    const minY = Math.floor(worldBounds.minY) - PADDING;
    const maxX = Math.ceil(worldBounds.maxX) + PADDING;
    const maxY = Math.ceil(worldBounds.maxY) + PADDING;

    return {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY)
    };
}

function parseChromaColor(ck, hex) {
    if (!hex) return null;
    const clean = hex.replace(/^#/, "").trim();
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
        console.warn(`CHROMA_COLOR "${hex}" bukan hex 6-digit valid (contoh: 00B140), fallback ke hitam.`);
        return null;
    }
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return ck.Color(r, g, b, 1);
}

function resolveBgColor(ck) {
    if (process.env.ALPHA === "1") return ck.TRANSPARENT;
    const chroma = parseChromaColor(ck, process.env.CHROMA_COLOR);
    return chroma || ck.BLACK;
}

function positionAndRender(ck, renderer, canvas, drawable, originX, originY, clearColor, scale = 1) {
    const skeleton = drawable.skeleton;

    skeleton.x = -originX;
    skeleton.y = -originY;
    skeleton.updateWorldTransform(Physics.none);

    canvas.clear(clearColor);
    canvas.save();
    if (scale !== 1) canvas.scale(scale, scale);
    renderer.render(canvas, drawable);
    canvas.restore();
}

function snapshotToPng(ck, surface) {
    // CanvasKit encodeToBytes() ternyata nyimpen buffer RGB apa adanya
    // (premultiplied) tanpa di-unpremultiply dulu ke PNG - hasilnya pixel
    // semi-transparent (mis. tepi halo/glow yang lembut) punya RGB yang
    // udah "digelapin" ke arah hitam sebanding alpha-nya, bukan warna
    // aslinya. Ini nyaris tidak kelihatan di sprite karakter biasa (area
    // semi-transparent-nya cuma tepi AA tipis), tapi SANGAT kelihatan di
    // texture yang isinya mayoritas gradient halus (halo/glow/light),
    // muncul sebagai "hitam-hitam" di area yang harusnya cuma pudar.
    // Fix: baca pixel mentah dengan alphaType Unpremul secara eksplisit
    // (warna asli sudah "dibagi balik" oleh alpha-nya), baru encode PNG
    // manual lewat pngjs - hasilnya straight alpha yang benar.
    try {
        const width = surface.width();
        const height = surface.height();
        const pixels = snapshotPixels(ck, surface, width, height);
        const png = new PNG({ width, height });
        png.data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        return PNG.sync.write(png);
    } catch (err) {
        if (!snapshotToPng._warned) {
            console.warn(`Catatan: PNG encode via unpremultiply gagal (${err.message}), fallback ke CanvasKit encodeToBytes() (berisiko RGB premultiplied di area semi-transparent).`);
            snapshotToPng._warned = true;
        }
    }

    const image = surface.makeImageSnapshot();
    if (!image) throw new Error("CanvasKit makeImageSnapshot() gagal.");

    try {
        if (typeof image.encodeToBytes === "function") {
            const bytes = image.encodeToBytes();
            if (!bytes) throw new Error("CanvasKit encodeToBytes() gagal.");
            return Buffer.from(bytes);
        }

        // Compatibility fallback for CanvasKit builds that expose the
        // underlying Embind method instead of the JS convenience wrapper.
        if (typeof image._encodeToData === "function") {
            const data = image._encodeToData();
            if (!data) throw new Error("CanvasKit _encodeToData() gagal.");
            if (typeof data.bytes === "function") {
                return Buffer.from(data.bytes());
            }
            if (typeof data.toBytes === "function") {
                return Buffer.from(data.toBytes());
            }
        }

        throw new Error("CanvasKit Image tidak menyediakan encodeToBytes().");
    } finally {
        if (typeof image.delete === "function") image.delete();
    }
}

function decodePng(pngBytes) {
    const decoded = PNG.sync.read(pngBytes);
    return decoded.data;
}

// Ambil raw RGBA langsung dari SkImage tanpa lewat PNG encode+decode.
// Dipakai di loop bounds scan (pass 2) yang cuma butuh baca channel alpha
// tiap pixel - encode ke PNG (compress) lalu decode lagi (decompress) itu
// kerjaan CPU yang sama sekali gak perlu buat kebutuhan ini.
function snapshotPixels(ck, surface, width, height) {
    const image = surface.makeImageSnapshot();
    if (!image) throw new Error("CanvasKit makeImageSnapshot() gagal.");

    try {
        const pixels = image.readPixels(0, 0, {
            width,
            height,
            alphaType: ck.AlphaType.Unpremul,
            colorType: ck.ColorType.RGBA_8888,
            colorSpace: ck.ColorSpace.SRGB,
        });
        if (!pixels) throw new Error("CanvasKit readPixels() gagal.");
        return pixels;
    } finally {
        if (typeof image.delete === "function") image.delete();
    }
}

function unionVisiblePixels(union, pixels, width, height) {
    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
            if (pixels[row + x * 4 + 3] > 0) {
                if (x < union.minX) union.minX = x;
                if (y < union.minY) union.minY = y;
                if (x > union.maxX) union.maxX = x;
                if (y > union.maxY) union.maxY = y;
            }
        }
    }
}

function pixelUnionToFinalBounds(pixelUnion, safe) {
    if (pixelUnion.maxX < 0) throw new Error("Tidak ada pixel terlihat selama Action + Idle.");

    const width = pixelUnion.maxX - pixelUnion.minX + 1;
    const height = pixelUnion.maxY - pixelUnion.minY + 1;

    return {
        width,
        height,
        // Final skeleton origin in world coordinates.
        // safe origin maps to pixel 0; crop starts at pixelUnion.minX/minY.
        originX: safe.minX + pixelUnion.minX,
        originY: safe.minY + pixelUnion.minY,
        cropX: pixelUnion.minX,
        cropY: pixelUnion.minY
    };
}

function makeEvenDimensions(bounds) {
    // libx264 (video encode) mewajibkan lebar & tinggi kelipatan 2.
    // Kalau ganjil, tambah 1 pixel (extend ke kanan/bawah) - efeknya
    // gak kelihatan (cuma nambah 1 baris/kolom transparan/hitam tipis),
    // tapi bikin ffmpeg gak reject video-nya.
    const width = bounds.width % 2 === 0 ? bounds.width : bounds.width + 1;
    const height = bounds.height % 2 === 0 ? bounds.height : bounds.height + 1;

    return {
        ...bounds,
        width,
        height
    };
}

function startFFmpeg(width, height, output) {
    const args = [
        "-y",
        "-loglevel", "warning",
        "-f", "image2pipe",
        "-framerate", String(FPS),
        "-vcodec", "png",
        "-i", "-",
        "-an",
        "-c:v", "libx264",
        "-preset", process.env.PRESET || "medium",
        "-crf", process.env.CRF || "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        output
    ];

    const ff = spawn(FFMPEG, args, { stdio: ["pipe", "inherit", "inherit"] });

    ff.on("error", err => {
        console.error("FFmpeg error:", err.message);
    });

    return ff;
}

function waitForProcess(proc) {
    return new Promise((resolve, reject) => {
        proc.on("close", code => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg berhenti dengan exit code ${code}.`));
        });
        proc.on("error", reject);
    });
}

function loadSequenceInfo(skeletonData) {
    const sequence = makeSequence(skeletonData);

    console.log(`Action : ${sequence.actionDuration.toFixed(6)} sec`);
    console.log(`Idle   : ${sequence.idleDuration.toFixed(6)} sec`);
    if (sequence.hasExtra) {
        console.log(`Extra  : ${sequence.extraDuration.toFixed(6)} sec (${sequence.extra.name})`);
    }
    console.log(`Total  : ${sequence.totalDuration.toFixed(6)} sec`);
    console.log(`FPS    : ${FPS}`);

    const actionFrames = totalFramesFor(sequence.actionDuration);
    const idleFrames = totalFramesFor(sequence.idleDuration);
    const extraFrames = sequence.hasExtra ? totalFramesFor(sequence.extraDuration) : 0;
    const totalFrames = Math.max(1, actionFrames + idleFrames + extraFrames);

    console.log(`Frames : ${totalFrames}`);

    return { sequence, totalFrames };
}

function computeGameBounds(skeletonData) {
    const width = Math.max(1, Math.ceil(skeletonData.width));
    const height = Math.max(1, Math.ceil(skeletonData.height));
    const originX = skeletonData.x;
    const originY = skeletonData.y;

    console.log("========================================");
    console.log("BOUNDS MODE: game (statis, dari skeleton.json)");
    console.log(`skeleton.x=${originX}, y=${originY}`);
    console.log(`skeleton.width=${skeletonData.width}, height=${skeletonData.height}`);
    console.log(`FINAL CANVAS: ${width}x${height}`);
    console.log(`FINAL ORIGIN: (${originX}, ${originY})`);
    console.log("Catatan: bounds statis, tidak di-scan ulang per frame.");
    console.log("========================================");

    return makeEvenDimensions({ width, height, originX, originY, cropX: 0, cropY: 0 });
}

async function computeFinalBounds(ck, skeletonData, sequence, totalFrames, renderer) {
    if (BOUNDS_SOURCE === "game") {
        return computeGameBounds(skeletonData);
    }

    console.log("[3/7] Scanning Spine world bounds: Action + Idle...");

    const worldUnion = newUnion();
    const sim1 = createSequenceSimulator(skeletonData, sequence);
    const t1start = Date.now();

    for (let i = 0; i < totalFrames; i++) {
        const t = i / FPS;
        sim1.advanceTo(t);
        updateUnion(worldUnion, getBounds(sim1.drawable.skeleton));
        printProgress(i + 1, totalFrames, t1start);
    }

    const safe = makeSafeCanvasSize(worldUnion);

    console.log(`Safe world canvas: ${safe.width}x${safe.height}`);
    console.log(`World min: (${worldUnion.minX.toFixed(3)}, ${worldUnion.minY.toFixed(3)})`);
    console.log(`World max: (${worldUnion.maxX.toFixed(3)}, ${worldUnion.maxY.toFixed(3)})`);

    console.log("  Downscaled bounds scan (cepat) lalu dikonversi balik ke resolusi penuh");

    const DOWNSCALE = Number(process.env.BOUNDS_DOWNSCALE || 4);
    const PAD_EXTRA = Number(process.env.BOUNDS_PADDING || 16);

    const smallW = Math.max(1, Math.ceil(safe.width / DOWNSCALE));
    const smallH = Math.max(1, Math.ceil(safe.height / DOWNSCALE));

    const smallSurface = ck.MakeSurface(smallW, smallH);
    if (!smallSurface) throw new Error(`CanvasKit gagal membuat surface kecil ${smallW}x${smallH}`);
    const smallCanvas = smallSurface.getCanvas();
    const smallUnion = newUnion();
    const sim2 = createSequenceSimulator(skeletonData, sequence);
    const t2start = Date.now();

    for (let i = 0; i < totalFrames; i++) {
        const t = i / FPS;
        sim2.advanceTo(t);

        smallCanvas.save();
        smallCanvas.scale(1 / DOWNSCALE, 1 / DOWNSCALE);
        positionAndRender(ck, renderer, smallCanvas, sim2.drawable, safe.minX, safe.minY, ck.TRANSPARENT);
        smallCanvas.restore();

        const pixels = snapshotPixels(ck, smallSurface, smallW, smallH);
        unionVisiblePixels(smallUnion, pixels, smallW, smallH);
        printProgress(i + 1, totalFrames, t2start);
    }

    if (typeof smallSurface.delete === "function") smallSurface.delete();

    const pixelUnion = {
        minX: Math.max(0, Math.floor(smallUnion.minX * DOWNSCALE) - PAD_EXTRA),
        minY: Math.max(0, Math.floor(smallUnion.minY * DOWNSCALE) - PAD_EXTRA),
        maxX: Math.min(safe.width - 1, Math.ceil((smallUnion.maxX + 1) * DOWNSCALE) - 1 + PAD_EXTRA),
        maxY: Math.min(safe.height - 1, Math.ceil((smallUnion.maxY + 1) * DOWNSCALE) - 1 + PAD_EXTRA)
    };

    const finalBounds = makeEvenDimensions(pixelUnionToFinalBounds(pixelUnion, safe));

    console.log("========================================");
    console.log(`FINAL CANVAS: ${finalBounds.width}x${finalBounds.height}`);
    console.log(`FINAL ORIGIN: (${finalBounds.originX}, ${finalBounds.originY})`);
    console.log("Scale: 1.000000 (NO SCALE)");
    console.log("Crop: none outside global Action+Idle pixel union");
    console.log("========================================");

    return finalBounds;
}

async function runBoundsPass1Mode() {
    fs.mkdirSync(path.dirname(PASS1_FILE), { recursive: true });

    const ck = await CanvasKitInit();
    console.log("[1/7] Loading CanvasKit...");
    console.log("[2/7] Loading atlas + skeleton...");
    const atlas = await loadTextureAtlas(ck, ATLAS, readFile);
    const skeletonData = await loadSkeletonData(JSON_FILE, atlas, readFile);
    const { sequence, totalFrames } = loadSequenceInfo(skeletonData);

    if (BOUNDS_SOURCE === "game") {
        const finalBounds = applyRenderScale(computeGameBounds(skeletonData));
        fs.writeFileSync(PASS1_FILE, JSON.stringify({
            mode: "game",
            finalBounds,
            totalFrames,
            fps: FPS
        }, null, 2));
        console.log(`Pass1 (mode game, tidak perlu shard) ditulis ke ${PASS1_FILE}`);
        return;
    }

    console.log("[3/7] Scanning Spine world bounds (vector, murah): Action + Idle...");
    const sim = createSequenceSimulator(skeletonData, sequence);
    const worldUnion = newUnion();
    const t0 = Date.now();

    for (let i = 0; i < totalFrames; i++) {
        sim.advanceTo(i / FPS);
        updateUnion(worldUnion, getBounds(sim.drawable.skeleton));
        printProgress(i + 1, totalFrames, t0);
    }

    const safe = makeSafeCanvasSize(worldUnion);
    console.log(`Safe world canvas: ${safe.width}x${safe.height}`);
    console.log(`World min: (${worldUnion.minX.toFixed(3)}, ${worldUnion.minY.toFixed(3)})`);
    console.log(`World max: (${worldUnion.maxX.toFixed(3)}, ${worldUnion.maxY.toFixed(3)})`);

    fs.writeFileSync(PASS1_FILE, JSON.stringify({
        mode: "dynamic",
        safe,
        totalFrames,
        fps: FPS
    }, null, 2));
    console.log(`Pass1 ditulis ke ${PASS1_FILE}`);
}

async function runBoundsShardMode() {
    const pass1 = JSON.parse(fs.readFileSync(PASS1_FILE, "utf8"));

    fs.mkdirSync(path.dirname(SHARD_FILE), { recursive: true });

    if (pass1.mode === "game") {
        // Mode game tidak butuh pixel scan sama sekali - tulis union kosong
        // (sentinel) biar shard ini selesai secepat mungkin, bounds-merge
        // bakal skip pemakaiannya karena baca finalBounds langsung dari pass1.
        fs.writeFileSync(SHARD_FILE, JSON.stringify(newUnion(), null, 2));
        console.log("Pass1 mode=game, shard ini skip (tidak ada yang perlu di-scan).");
        return;
    }

    if (SHARD_END <= SHARD_START) {
        fs.writeFileSync(SHARD_FILE, JSON.stringify(newUnion(), null, 2));
        console.log(`Shard kosong (SHARD_START=${SHARD_START} >= SHARD_END=${SHARD_END}), skip.`);
        return;
    }

    const ck = await CanvasKitInit();
    console.log("[1/7] Loading CanvasKit...");
    console.log("[2/7] Loading atlas + skeleton...");
    const atlas = await loadTextureAtlas(ck, ATLAS, readFile);
    const skeletonData = await loadSkeletonData(JSON_FILE, atlas, readFile);
    const { sequence } = loadSequenceInfo(skeletonData);
    const renderer = new SkeletonRenderer(ck);

    const safe = pass1.safe;
    const DOWNSCALE = Number(process.env.BOUNDS_DOWNSCALE || 4);
    const smallW = Math.max(1, Math.ceil(safe.width / DOWNSCALE));
    const smallH = Math.max(1, Math.ceil(safe.height / DOWNSCALE));

    const smallSurface = ck.MakeSurface(smallW, smallH);
    if (!smallSurface) throw new Error(`CanvasKit gagal membuat surface kecil ${smallW}x${smallH}`);
    const smallCanvas = smallSurface.getCanvas();
    const smallUnion = newUnion();
    const sim = createSequenceSimulator(skeletonData, sequence);

    // Simulator cuma bisa maju waktu (advanceTo), jadi warm-up dari frame 0
    // sampai SHARD_START DULU (tanpa render/scan) baru mulai kerja beneran.
    console.log(`  Warm-up 0..${SHARD_START} (tanpa render/scan)...`);
    for (let i = 0; i < SHARD_START; i++) {
        sim.advanceTo(i / FPS);
    }

    console.log(`  Scanning pixel-perfect frame ${SHARD_START}..${SHARD_END}...`);
    const t0 = Date.now();
    const shardTotal = SHARD_END - SHARD_START;

    for (let i = SHARD_START; i < SHARD_END; i++) {
        const t = i / FPS;
        sim.advanceTo(t);

        smallCanvas.save();
        smallCanvas.scale(1 / DOWNSCALE, 1 / DOWNSCALE);
        positionAndRender(ck, renderer, smallCanvas, sim.drawable, safe.minX, safe.minY, ck.TRANSPARENT);
        smallCanvas.restore();

        const pixels = snapshotPixels(ck, smallSurface, smallW, smallH);
        unionVisiblePixels(smallUnion, pixels, smallW, smallH);
        printProgress(i - SHARD_START + 1, shardTotal, t0);
    }

    if (typeof smallSurface.delete === "function") smallSurface.delete();

    fs.writeFileSync(SHARD_FILE, JSON.stringify(smallUnion, null, 2));
    console.log(`Shard ${SHARD_START}..${SHARD_END} selesai, union ditulis ke ${SHARD_FILE}`);
}

async function runBoundsMergeMode() {
    fs.mkdirSync(path.dirname(BOUNDS_FILE), { recursive: true });

    const pass1 = JSON.parse(fs.readFileSync(PASS1_FILE, "utf8"));

    if (pass1.mode === "game") {
        fs.writeFileSync(BOUNDS_FILE, JSON.stringify({
            finalBounds: pass1.finalBounds,
            totalFrames: pass1.totalFrames,
            fps: pass1.fps
        }, null, 2));
        console.log("Mode game: finalBounds dari pass1 dipakai langsung (tidak ada shard yang perlu digabung).");
        console.log(`FINAL CANVAS: ${pass1.finalBounds.width}x${pass1.finalBounds.height}`);
        return;
    }

    const safe = pass1.safe;
    const shardFiles = fs.readdirSync(SHARDS_DIR).filter(f => f.endsWith(".json"));
    if (shardFiles.length === 0) {
        throw new Error(`Tidak ada file shard ditemukan di ${SHARDS_DIR}`);
    }

    console.log(`Menggabungkan ${shardFiles.length} shard dari ${SHARDS_DIR}...`);
    const smallUnion = newUnion();
    for (const f of shardFiles) {
        const partial = JSON.parse(fs.readFileSync(path.join(SHARDS_DIR, f), "utf8"));
        updateUnion(smallUnion, partial);
    }

    const DOWNSCALE = Number(process.env.BOUNDS_DOWNSCALE || 4);
    const PAD_EXTRA = Number(process.env.BOUNDS_PADDING || 16);

    const pixelUnion = {
        minX: Math.max(0, Math.floor(smallUnion.minX * DOWNSCALE) - PAD_EXTRA),
        minY: Math.max(0, Math.floor(smallUnion.minY * DOWNSCALE) - PAD_EXTRA),
        maxX: Math.min(safe.width - 1, Math.ceil((smallUnion.maxX + 1) * DOWNSCALE) - 1 + PAD_EXTRA),
        maxY: Math.min(safe.height - 1, Math.ceil((smallUnion.maxY + 1) * DOWNSCALE) - 1 + PAD_EXTRA)
    };

    const finalBounds = applyRenderScale(makeEvenDimensions(pixelUnionToFinalBounds(pixelUnion, safe)));

    console.log("========================================");
    console.log(`FINAL CANVAS: ${finalBounds.width}x${finalBounds.height}`);
    console.log(`FINAL ORIGIN: (${finalBounds.originX}, ${finalBounds.originY})`);
    console.log("Crop: none outside global Action+Idle pixel union (digabung dari semua shard)");
    console.log("========================================");

    fs.writeFileSync(BOUNDS_FILE, JSON.stringify({
        finalBounds,
        totalFrames: pass1.totalFrames,
        fps: pass1.fps
    }, null, 2));
    console.log(`Bounds final ditulis ke ${BOUNDS_FILE}`);
}

async function runBoundsMode() {
    fs.mkdirSync(path.dirname(BOUNDS_FILE), { recursive: true });

    const ck = await CanvasKitInit();
    const atlas = await loadTextureAtlas(ck, ATLAS, readFile);
    const skeletonData = await loadSkeletonData(JSON_FILE, atlas, readFile);
    const renderer = new SkeletonRenderer(ck);

    const { sequence, totalFrames } = loadSequenceInfo(skeletonData);
    const finalBounds = applyRenderScale(await computeFinalBounds(ck, skeletonData, sequence, totalFrames, renderer));

    fs.writeFileSync(BOUNDS_FILE, JSON.stringify({ finalBounds, totalFrames, fps: FPS }, null, 2));
    console.log(`Bounds ditulis ke ${BOUNDS_FILE}`);
}

async function runFramesMode() {
    const { finalBounds, totalFrames } = JSON.parse(fs.readFileSync(BOUNDS_FILE, "utf8"));
    const end = FRAME_END > 0 ? Math.min(FRAME_END, totalFrames) : totalFrames;

    fs.mkdirSync(FRAMES_OUT, { recursive: true });

    const ck = await CanvasKitInit();
    const atlas = await loadTextureAtlas(ck, ATLAS, readFile);
    const skeletonData = await loadSkeletonData(JSON_FILE, atlas, readFile);
    const renderer = new SkeletonRenderer(ck);
    const { sequence } = loadSequenceInfo(skeletonData);

    const sim = createSequenceSimulator(skeletonData, sequence);

    console.log(`Warm-up 0..${FRAME_START} (tanpa render)...`);
    for (let i = 0; i < FRAME_START; i++) {
        sim.advanceTo(i / FPS);
    }

    const surface = ck.MakeSurface(finalBounds.width, finalBounds.height);
    if (!surface) throw new Error(`CanvasKit gagal membuat surface ${finalBounds.width}x${finalBounds.height}`);
    const canvas = surface.getCanvas();
    const t0 = Date.now();
    const shardTotal = end - FRAME_START;

    console.log(`Rendering frame ${FRAME_START}..${end - 1} -> ${FRAMES_OUT}`);

    const bgColor = resolveBgColor(ck);

    for (let i = FRAME_START; i < end; i++) {
        sim.advanceTo(i / FPS);

        positionAndRender(ck, renderer, canvas, sim.drawable, finalBounds.originX, finalBounds.originY, bgColor, finalBounds.renderScale || 1);

        const pngBytes = snapshotToPng(ck, surface);
        const framePath = path.join(FRAMES_OUT, `frame_${String(i).padStart(6, "0")}.png`);
        fs.writeFileSync(framePath, pngBytes);

        printProgress(i - FRAME_START + 1, shardTotal, t0);
    }

    if (typeof surface.delete === "function") surface.delete();
    console.log(`Selesai: ${shardTotal} frame ditulis ke ${FRAMES_OUT}`);
}

async function runSingleMode() {
    console.log("========================================");
    console.log(" SPINE 4.2.120 -> ACTION + IDLE -> MP4");
    console.log("========================================");

    fs.mkdirSync(ROOT, { recursive: true });

    console.log("[1/7] Initializing CanvasKit...");
    const ck = await CanvasKitInit();

    console.log("[2/7] Loading atlas + skeleton...");
    const atlas = await loadTextureAtlas(ck, ATLAS, readFile);
    const skeletonData = await loadSkeletonData(JSON_FILE, atlas, readFile);
    const renderer = new SkeletonRenderer(ck);
    const { sequence, totalFrames } = loadSequenceInfo(skeletonData);

    const finalBounds = applyRenderScale(await computeFinalBounds(ck, skeletonData, sequence, totalFrames, renderer));

    console.log("[5/7] Creating final surface + FFmpeg...");
    console.log("  Frame transport: PNG image2pipe -> FFmpeg (no raw pixel readback)");

    const finalSurface = ck.MakeSurface(finalBounds.width, finalBounds.height);
    if (!finalSurface) throw new Error(`CanvasKit gagal membuat final surface ${finalBounds.width}x${finalBounds.height}`);
    const finalCanvas = finalSurface.getCanvas();

    const ff = startFFmpeg(finalBounds.width, finalBounds.height, OUTPUT);
    const sim3 = createSequenceSimulator(skeletonData, sequence);
    const t3start = Date.now();

    console.log("[6/7] Rendering MP4 frames...");

    for (let i = 0; i < totalFrames; i++) {
        const t = i / FPS;
        sim3.advanceTo(t);

        positionAndRender(ck, renderer, finalCanvas, sim3.drawable, finalBounds.originX, finalBounds.originY, resolveBgColor(ck), finalBounds.renderScale || 1);

        const pngBytes = snapshotToPng(ck, finalSurface);

        if (!ff.stdin.write(pngBytes)) {
            await new Promise(resolve => ff.stdin.once("drain", resolve));
        }

        printProgress(i + 1, totalFrames, t3start);
    }

    ff.stdin.end();
    console.log("  Menunggu FFmpeg selesai encode ke MP4...");
    await waitForProcess(ff);

    if (typeof finalSurface.delete === "function") finalSurface.delete();

    console.log("[7/7] DONE");
    console.log("========================================");
    console.log(`Output : ${OUTPUT}`);
    console.log(`Size   : ${finalBounds.width}x${finalBounds.height}`);
    console.log(`FPS    : ${FPS}`);
    console.log(`Frames : ${totalFrames}`);
    console.log(`Time   : ${(totalFrames / FPS).toFixed(6)} sec`);
    console.log("Action: original duration, once");
    console.log(sequence.idleDuration !== (sequence.idle ? sequence.idle.duration : 0)
        ? `Idle  : durasi di-override (loop otomatis kalau lebih panjang dari animasi asli)`
        : "Idle  : original duration, once (NO LOOP)");
    if (sequence.hasExtra) {
        console.log(`Extra : ${sequence.extra.name} (${sequence.extraDuration.toFixed(3)}s) setelah idle`);
    }
    console.log("Scale : 1:1");
    console.log("========================================");
}

// --------------------------------------------------------
// Render 1 frame (posisi skeleton saat ini) jadi PNG dengan
// crop yang ketat pas ke bounding box pixel karakter (tidak
// ada pixel kepotong, tidak ada sisa ruang kosong berlebih),
// background transparan.
// --------------------------------------------------------
async function renderTightFramePng(ck, renderer, drawable, outPath) {
    const worldBounds = getBounds(drawable.skeleton);
    const safe = makeSafeCanvasSize(worldBounds);

    const DOWNSCALE = Number(process.env.BOUNDS_DOWNSCALE || 4);
    const PAD_EXTRA = Number(process.env.THUMB_PADDING || 4);

    const smallW = Math.max(1, Math.ceil(safe.width / DOWNSCALE));
    const smallH = Math.max(1, Math.ceil(safe.height / DOWNSCALE));

    const smallSurface = ck.MakeSurface(smallW, smallH);
    if (!smallSurface) throw new Error(`CanvasKit gagal membuat surface kecil ${smallW}x${smallH}`);
    const smallCanvas = smallSurface.getCanvas();

    smallCanvas.save();
    smallCanvas.scale(1 / DOWNSCALE, 1 / DOWNSCALE);
    positionAndRender(ck, renderer, smallCanvas, drawable, safe.minX, safe.minY, ck.TRANSPARENT);
    smallCanvas.restore();

    const smallPixels = snapshotPixels(ck, smallSurface, smallW, smallH);
    const smallUnion = newUnion();
    unionVisiblePixels(smallUnion, smallPixels, smallW, smallH);
    if (typeof smallSurface.delete === "function") smallSurface.delete();

    const pixelUnion = {
        minX: Math.max(0, Math.floor(smallUnion.minX * DOWNSCALE) - PAD_EXTRA),
        minY: Math.max(0, Math.floor(smallUnion.minY * DOWNSCALE) - PAD_EXTRA),
        maxX: Math.min(safe.width - 1, Math.ceil((smallUnion.maxX + 1) * DOWNSCALE) - 1 + PAD_EXTRA),
        maxY: Math.min(safe.height - 1, Math.ceil((smallUnion.maxY + 1) * DOWNSCALE) - 1 + PAD_EXTRA)
    };

    const tightBounds = pixelUnionToFinalBounds(pixelUnion, safe);

    const surface = ck.MakeSurface(tightBounds.width, tightBounds.height);
    if (!surface) throw new Error(`CanvasKit gagal membuat surface ${tightBounds.width}x${tightBounds.height}`);
    const canvas = surface.getCanvas();

    positionAndRender(ck, renderer, canvas, drawable, tightBounds.originX, tightBounds.originY, ck.TRANSPARENT);
    const finalPng = snapshotToPng(ck, surface);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, finalPng);

    if (typeof surface.delete === "function") surface.delete();

    console.log(`  Disimpan: ${outPath} (${tightBounds.width}x${tightBounds.height})`);
}

// --------------------------------------------------------
// MODE=thumbnail:
//   - Kalau ada animasi "idle" -> 1 thumbnail dari frame
//     pertama (t=0) animasi idle (perilaku lama).
//   - Kalau TIDAK ada animasi "idle" -> 3 thumbnail dari
//     animasi yang tersedia (biasanya "action"): frame
//     pertama, tengah, dan terakhir.
// --------------------------------------------------------
async function runThumbnailMode() {
    const ck = await CanvasKitInit();
    const atlas = await loadTextureAtlas(ck, ATLAS, readFile);
    const skeletonData = await loadSkeletonData(JSON_FILE, atlas, readFile);
    const renderer = new SkeletonRenderer(ck);

    // Pakai resolusi nama animasi yang sama dengan video (auto-fallback
    // ke animasi pertama kalau "action"/"idle" tidak ditemukan).
    const sequence = makeSequence(skeletonData);

    if (sequence.hasIdle) {
        console.log(`Thumbnail dari animasi: ${sequence.idle.name} (frame pertama, t=0)`);
        const drawable = createDrawable(skeletonData);
        resetAndStart(drawable, sequence.idle.name, false);
        await renderTightFramePng(ck, renderer, drawable, THUMBNAIL_OUT);
        return;
    }

    // Tidak ada "idle" -> 3 thumbnail dari animasi yang ada.
    const animName = sequence.action.name;
    const duration = sequence.action.duration;
    console.log(`Tidak ada animasi idle terpisah. Membuat 3 thumbnail dari "${animName}" (awal, tengah, akhir).`);

    const dir = path.dirname(THUMBNAIL_OUT);
    const ext = path.extname(THUMBNAIL_OUT) || ".png";
    const base = path.basename(THUMBNAIL_OUT, ext);

    const frames = [
        { label: "first", time: 0 },
        { label: "middle", time: duration / 2 },
        { label: "last", time: Math.max(0, duration - 1 / FPS) }
    ];

    for (const f of frames) {
        const drawable = createDrawable(skeletonData);
        resetAndStart(drawable, animName, false);
        if (f.time > 0) {
            step(drawable, f.time);
        }
        console.log(`  Frame ${f.label} (t=${f.time.toFixed(3)}s)`);
        const outPath = path.join(dir, `${base}_${f.label}${ext}`);
        await renderTightFramePng(ck, renderer, drawable, outPath);
    }
}

async function main() {
    if (MODE === "bounds") {
        await runBoundsMode();
    } else if (MODE === "bounds-pass1") {
        await runBoundsPass1Mode();
    } else if (MODE === "bounds-shard") {
        await runBoundsShardMode();
    } else if (MODE === "bounds-merge") {
        await runBoundsMergeMode();
    } else if (MODE === "frames") {
        await runFramesMode();
    } else if (MODE === "thumbnail") {
        await runThumbnailMode();
    } else {
        await runSingleMode();
    }
}

main().catch(error => {
    console.error("\n========================================");
    console.error("MP4 RENDER ERROR");
    console.error("========================================");
    console.error(error?.stack || error);
    process.exit(1);
});
