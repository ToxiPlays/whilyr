const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.0/build/mp4-muxer.mjs';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const VIDEO_CODEC = 'avc1.640028';      // H.264 High, level 4.0
const VIDEO_BITRATE = 6_000_000;
const AUDIO_CODEC = 'mp4a.40.2';        // AAC-LC
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 192_000;
const AUDIO_BLOCK_FRAMES = 1024;
const KEYFRAME_INTERVAL = FPS * 2;
const QUEUE_LIMIT = 6;

// Typography and spacing mirror main.css: .lyrics is weight 700 at 1.5 line height,
// .bg-inner is 0.7em, and paragraphs add 0.3em margin plus 0.2em padding.
const FONT_STACK = 'Inter, "Helvetica Neue", Arial, sans-serif';
const MAIN_FONT_SIZE = 46;
const MAIN_LINE_HEIGHT = 69;
const ADLIB_FONT_SIZE = 32;
const ADLIB_LINE_HEIGHT = 48;
const MAIN_FONT = `700 ${MAIN_FONT_SIZE}px ${FONT_STACK}`;
const AD_FONT = `700 ${ADLIB_FONT_SIZE}px ${FONT_STACK}`;
const LINE_GAP = 32;

// Lyric column. Duet lines hug the right edge, others the left. Without duets, lines are centered.
const LYRIC_LEFT_X = 570;
const LYRIC_RIGHT_X = 1190;
const LYRIC_CENTER_X = (LYRIC_LEFT_X + LYRIC_RIGHT_X) / 2;
const LYRIC_MAX_WIDTH = LYRIC_RIGHT_X - LYRIC_LEFT_X;
const LYRIC_CENTER_Y = HEIGHT / 2;

const UNFILLED_ALPHA = 0.45;            // .word background colour in the CSS
const LINE_IDLE_ALPHA = 0.6;            // line-synced lines that are not the focus
const ADLIB_ALPHA = 0.8;                // .bg-line opacity when revealed
const ADLIB_FADE_IN = 0.6;              // seconds an ad-lib fades and expands in before its reveal
const WORD_FEATHER = 0.55;              // .word --feather
const WORD_GAP_EPSILON = 0.02;          // same as main.js
const SCROLL_LEAD = 0.35;               // seconds before a line starts that scrolling begins
const SCROLL_DURATION = 0.6;

const COVER_SIZE = 360;
const COVER_X = 96;

// Background: rendered at 1/BG_DOWNSCALE size and scaled back up, which blurs it.
const BG_DOWNSCALE = 16;
const BG_DRIFT_RATE = 0.05;             // radians per second, slow enough to feel calm
const BG_DRIFT_X = 10;                  // percent of width
const BG_DRIFT_Y = 8;                   // percent of height
const BG_OVERLAY = 'rgba(6, 7, 12, 0.12)';   // body::after in main.css
const REST_DARKNESS = 0.25;
const KICK_PULSE_DEPTH = 0.35;

const BASS_CUTOFF_HZ = 150;
const KICK_THRESHOLD = 0.03;
const KICK_RANGE = 0.15;
const KICK_DECAY = 0.25;

export function canExportVideo() {
    return typeof VideoEncoder !== 'undefined'
        && typeof AudioEncoder !== 'undefined'
        && typeof VideoFrame !== 'undefined'
        && typeof AudioData !== 'undefined'
        && typeof OfflineAudioContext !== 'undefined';
}

export function buildRenderFileName(title, artist) {
    const clean = (value, fallback) => String(value ?? '')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim() || fallback;

    return `Whilyr | ${clean(title, 'Untitled')} - ${clean(artist, 'Unknown Artist')}.mp4`;
}

export async function exportLyricVideo({ audioUrl, lyricElements, palette, coverImage, title, artist, onProgress = () => {} }) {
    if (!canExportVideo()) {
        throw new Error('WebCodecs is not available in this browser.');
    }

    const lines = extractLines(lyricElements);
    if (!lines.length) {
        throw new Error('There are no lyric lines to render.');
    }

    onProgress(0);

    const decoded = await decodeAudio(audioUrl);
    const totalFrames = Math.ceil(decoded.duration * FPS);
    const kick = computeKickEnvelope(decoded, totalFrames);

    try {
        await document.fonts.load(MAIN_FONT);
    } catch {
        // Fall back to whatever font the browser resolves.
    }

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    const layout = buildLayout(ctx, lines);

    const bgCanvas = document.createElement('canvas');
    bgCanvas.width = Math.round(WIDTH / BG_DOWNSCALE);
    bgCanvas.height = Math.round(HEIGHT / BG_DOWNSCALE);

    const { Muxer, ArrayBufferTarget } = await import(MUXER_URL);
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
        target,
        video: { codec: 'avc', width: WIDTH, height: HEIGHT },
        audio: { codec: 'aac', numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE },
        fastStart: 'in-memory',
    });

    let encoderError = null;
    const onEncoderError = (error) => { encoderError = error; };
    const throwIfFailed = () => { if (encoderError) throw encoderError; };

    const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: onEncoderError,
    });
    const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: onEncoderError,
    });

    const videoConfig = {
        codec: VIDEO_CODEC,
        width: WIDTH,
        height: HEIGHT,
        bitrate: VIDEO_BITRATE,
        framerate: FPS,
        avc: { format: 'avc' },
    };
    const audioConfig = {
        codec: AUDIO_CODEC,
        sampleRate: AUDIO_SAMPLE_RATE,
        numberOfChannels: AUDIO_CHANNELS,
        bitrate: AUDIO_BITRATE,
        aac: { format: 'aac' },
    };

    const [videoSupport, audioSupport] = await Promise.all([
        VideoEncoder.isConfigSupported(videoConfig),
        AudioEncoder.isConfigSupported(audioConfig),
    ]);
    if (!videoSupport.supported || !audioSupport.supported) {
        throw new Error('This browser cannot encode H.264 video with AAC audio.');
    }

    try {
        videoEncoder.configure(videoConfig);
        audioEncoder.configure(audioConfig);

        const rendered = await renderAudioStereo(decoded);
        await encodeAudio(rendered, audioEncoder, throwIfFailed);
        await audioEncoder.flush();
        throwIfFailed();
        onProgress(0.1);

        const scene = { palette, coverImage, title, artist, layout, kick, bgCanvas };
        const frameDuration = Math.round(1e6 / FPS);

        for (let i = 0; i < totalFrames; i += 1) {
            drawFrame(ctx, scene, i);

            const frame = new VideoFrame(canvas, {
                timestamp: Math.round((i * 1e6) / FPS),
                duration: frameDuration,
            });
            videoEncoder.encode(frame, { keyFrame: i % KEYFRAME_INTERVAL === 0 });
            frame.close();

            await waitForQueue(videoEncoder);
            throwIfFailed();

            if (i % 10 === 0) {
                onProgress(0.1 + 0.9 * (i / totalFrames));
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }

        await videoEncoder.flush();
        throwIfFailed();
        muxer.finalize();
        onProgress(1);

        return new Blob([target.buffer], { type: 'video/mp4' });
    } finally {
        if (videoEncoder.state !== 'closed') videoEncoder.close();
        if (audioEncoder.state !== 'closed') audioEncoder.close();
    }
}

// ---------- audio ----------

async function decodeAudio(audioUrl) {
    const bytes = await (await fetch(audioUrl)).arrayBuffer();
    const context = new AudioContext();
    try {
        return await context.decodeAudioData(bytes);
    } finally {
        await context.close();
    }
}

async function renderAudioStereo(buffer) {
    const length = Math.ceil(buffer.duration * AUDIO_SAMPLE_RATE);
    const offline = new OfflineAudioContext(AUDIO_CHANNELS, length, AUDIO_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start(0);
    return offline.startRendering();
}

async function encodeAudio(rendered, encoder, throwIfFailed) {
    const left = rendered.getChannelData(0);
    const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;

    for (let offset = 0; offset < rendered.length; offset += AUDIO_BLOCK_FRAMES) {
        const frames = Math.min(AUDIO_BLOCK_FRAMES, rendered.length - offset);
        const planar = new Float32Array(frames * AUDIO_CHANNELS);
        planar.set(left.subarray(offset, offset + frames), 0);
        planar.set(right.subarray(offset, offset + frames), frames);

        const data = new AudioData({
            format: 'f32-planar',
            sampleRate: AUDIO_SAMPLE_RATE,
            numberOfFrames: frames,
            numberOfChannels: AUDIO_CHANNELS,
            timestamp: Math.round((offset * 1e6) / AUDIO_SAMPLE_RATE),
            data: planar,
        });
        encoder.encode(data);
        data.close();

        await waitForQueue(encoder);
        throwIfFailed();
    }
}

// Kick envelope per frame, computed offline from the decoded samples.
function computeKickEnvelope(buffer, frameCount) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const hop = buffer.sampleRate / FPS;
    const smoothing = 1 - Math.exp((-2 * Math.PI * BASS_CUTOFF_HZ) / buffer.sampleRate);
    const level = new Float32Array(frameCount);

    let filtered = 0;
    let sample = 0;
    for (let f = 0; f < frameCount; f += 1) {
        const end = Math.min(buffer.length, Math.round((f + 1) * hop));
        let energy = 0;
        let count = 0;

        for (; sample < end; sample += 1) {
            let mix = 0;
            for (let c = 0; c < channels.length; c += 1) mix += channels[c][sample];
            filtered += smoothing * ((mix / channels.length) - filtered);
            energy += filtered * filtered;
            count += 1;
        }

        level[f] = count ? Math.sqrt(energy / count) : 0;
    }

    const sorted = Float32Array.from(level).sort();
    const reference = sorted[Math.floor(sorted.length * 0.95)] || 1;

    const kick = new Float32Array(frameCount);
    const dt = 1 / FPS;
    const follow = 1 - Math.exp(-dt / 0.3);
    const decay = Math.exp(-dt / KICK_DECAY);
    let average = 0;
    let envelope = 0;

    for (let f = 0; f < frameCount; f += 1) {
        const bass = Math.min(1, level[f] / reference);
        const onset = clamp((bass - average - KICK_THRESHOLD) / KICK_RANGE, 0, 1);
        average += (bass - average) * follow;
        envelope = Math.max(onset, envelope * decay);
        kick[f] = envelope;
    }

    return kick;
}

// ---------- lyric extraction and layout ----------

// Reads the DOM that main.js builds. Word-timed lines carry _tracks; others are line-synced.
function extractLines(elements) {
    const parsed = elements.map((el) => {
        const start = Number(el.dataset.start || 0);
        const rawEnd = Number(el.dataset.end || NaN);
        const duet = el.classList.contains('duet-agent');
        const tracks = el._tracks || null;

        if (tracks) {
            return {
                start,
                rawEnd,
                duet,
                timed: true,
                main: trackToSpans(tracks[0]),
                adlibs: tracks.slice(1)
                    .map((track) => ({ ...trackToSpans(track), revealAt: track.revealAt }))
                    .filter((adlib) => adlib.words.length),
            };
        }

        return {
            start,
            rawEnd,
            duet,
            timed: false,
            main: { spans: [], words: splitWords(el.textContent) },
            adlibs: [],
        };
    }).filter((line) => line.timed || line.main.words.length);

    // Same end-time rule as getLineDisplayRange() in main.js.
    return parsed.map((line, index) => {
        const next = parsed[index + 1];
        const inferredEnd = next ? next.start : line.start;
        const end = Number.isFinite(line.rawEnd) && line.rawEnd > line.start
            ? line.rawEnd
            : Math.max(line.start, inferredEnd);

        return { ...line, end };
    });
}

// Keeps every syllable span (the unit the DOM fills) and groups them into words for wrapping.
// Spans sharing a .word-group parent belong to one word.
function trackToSpans(track) {
    if (!track) return { spans: [], words: [] };

    const spans = [];
    const words = [];
    let previousGroup = null;

    track.words.forEach(({ el, start, end }) => {
        const group = el.parentElement;
        const span = { text: el.textContent, start, end, index: spans.length };
        spans.push(span);

        if (words.length && group === previousGroup) {
            words[words.length - 1].spans.push(span);
        } else {
            words.push({ spans: [span] });
        }

        previousGroup = group;
    });

    return {
        spans,
        words: words.filter((word) => word.spans.some((span) => span.text.trim())),
    };
}

function splitWords(text) {
    return String(text ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((word, index) => ({ spans: [{ text: word, start: 0, end: 0, index }] }));
}

// Places words into wrapped rows. Each word keeps its spans with their x offsets.
function layoutWords(ctx, words, font, maxWidth) {
    ctx.font = font;
    const space = ctx.measureText(' ').width;
    const rows = [];
    let row = { items: [], width: 0 };

    words.forEach((word) => {
        let wordWidth = 0;
        const spans = word.spans.map((span) => {
            const w = ctx.measureText(span.text).width;
            const placed = { text: span.text, index: span.index, w, dx: wordWidth };
            wordWidth += w;
            return placed;
        });

        const needed = row.items.length ? row.width + space + wordWidth : wordWidth;
        if (row.items.length && needed > maxWidth) {
            rows.push(row);
            row = { items: [], width: 0 };
        }

        const x = row.items.length ? row.width + space : 0;
        row.items.push({ spans, x, w: wordWidth });
        row.width = x + wordWidth;
    });

    if (row.items.length) rows.push(row);
    return rows;
}

function buildLayout(ctx, lines) {
    const hasDuet = lines.some((line) => line.duet);

    const laidOut = lines.map((line) => {
        const align = !hasDuet ? 'center' : (line.duet ? 'right' : 'left');
        const mainRows = layoutWords(ctx, line.main.words, MAIN_FONT, LYRIC_MAX_WIDTH);
        const adlibGroups = line.adlibs.map((adlib) => {
            const rows = layoutWords(ctx, adlib.words, AD_FONT, LYRIC_MAX_WIDTH);
            return {
                spans: adlib.spans,
                revealAt: adlib.revealAt,
                rows,
                height: rows.length * ADLIB_LINE_HEIGHT,
            };
        });

        return {
            ...line,
            align,
            mainRows,
            mainHeight: mainRows.length * MAIN_LINE_HEIGHT,
            adlibGroups,
        };
    });

    return { lines: laidOut };
}

// ---------- timing ----------

// Per-span fill, copied from computeWordFills() in main.js. Spans with a gap after them
// hold at 80% until the next span starts, then the remainder fills in.
function computeSpanFills(spans, t) {
    return spans.map((w, i) => {
        const p = clamp((t - w.start) / Math.max(w.end - w.start, 0.001), 0, 1);
        const next = spans[i + 1];
        const hasGap = next && (next.start - w.end) > WORD_GAP_EPSILON;
        if (!hasGap) return p;
        if (t < next.start) return 0.8 * p;
        const nextDuration = Math.max(next.end - next.start, 0.001);
        return 0.9 + 0.1 * clamp((t - next.start) / (nextDuration * 0.25), 0, 1);
    });
}

// Ad-lib blocks expand and fade in together over ADLIB_FADE_IN seconds before their reveal.
// Lines below them move down as they open, as the DOM's grid transition does.
function computeFrameLayout(layout, t) {
    let top = 0;

    return layout.lines.map((line) => {
        let groupY = line.mainHeight;
        const groups = line.adlibGroups.map((group) => {
            const fade = clamp((t - (group.revealAt - ADLIB_FADE_IN)) / ADLIB_FADE_IN, 0, 1);
            const height = group.height * easeOutCubic(fade);
            const placed = { group, fade, y: groupY, height };
            groupY += height;
            return placed;
        });

        const frameLine = { line, top, mainHeight: line.mainHeight, height: groupY, groups };
        top += groupY + LINE_GAP;
        return frameLine;
    });
}

// Scroll position in line units. The focus moves onto the next line shortly before it starts,
// then holds on the line until the following line's scroll begins. Line highlighting follows it.
function getFocusIndex(lines, t) {
    const u = t + SCROLL_LEAD;
    let i = -1;
    for (let k = 0; k < lines.length && lines[k].start <= u; k += 1) i = k;

    if (i <= 0) return 0;
    const progress = easeInOutCubic(clamp((u - lines[i].start) / SCROLL_DURATION, 0, 1));
    return i - 1 + progress;
}

function getFocusY(frameLines, focus) {
    const last = frameLines.length - 1;
    const a = clamp(Math.floor(focus), 0, last);
    const b = clamp(a + 1, 0, last);
    const fraction = clamp(focus - a, 0, 1);

    const centerA = frameLines[a].top + frameLines[a].mainHeight / 2;
    const centerB = frameLines[b].top + frameLines[b].mainHeight / 2;
    return centerA + (centerB - centerA) * fraction;
}

// ---------- drawing ----------

function drawFrame(ctx, scene, frameIndex) {
    const t = frameIndex / FPS;

    drawBackground(ctx, scene.bgCanvas, scene.palette, t, scene.kick[frameIndex]);
    drawHeader(ctx, scene.coverImage, scene.title, scene.artist);
    drawLyrics(ctx, scene.layout, t);
}

// Paints the gradient at low resolution, then scales it up. The soft result is the blur.
function drawBackground(ctx, bgCanvas, palette, t, kick) {
    const bg = bgCanvas.getContext('2d');
    const scaleX = bgCanvas.width / WIDTH;
    const scaleY = bgCanvas.height / HEIGHT;

    const darkness = REST_DARKNESS * (1 - kick * KICK_PULSE_DEPTH);
    const [colorA, colorB, colorC] = palette.map((hex) => darken(hex, darkness));

    const phase = t * BG_DRIFT_RATE;
    const driftX = 50 + Math.sin(phase) * BG_DRIFT_X;
    const driftY = 50 + Math.cos(phase * 0.7 + 1.2) * BG_DRIFT_Y;

    bg.setTransform(scaleX, 0, 0, scaleY, 0, 0);

    const base = bg.createLinearGradient(0, 0, WIDTH, HEIGHT);
    base.addColorStop(0, darken(colorA, 0.18));
    base.addColorStop(0.52, darken(colorB, 0.22));
    base.addColorStop(1, darken(colorC, 0.2));
    bg.fillStyle = base;
    bg.fillRect(0, 0, WIDTH, HEIGHT);

    const cx = (WIDTH * driftX) / 100;
    const cy = (HEIGHT * driftY) / 100;
    const reach = Math.max(
        Math.hypot(cx, cy),
        Math.hypot(WIDTH - cx, cy),
        Math.hypot(cx, HEIGHT - cy),
        Math.hypot(WIDTH - cx, HEIGHT - cy),
    );

    const radial = bg.createRadialGradient(cx, cy, 0, cx, cy, reach);
    radial.addColorStop(0, rgba(colorA, 0.94));
    radial.addColorStop(0.5, rgba(colorB, 0.88));
    radial.addColorStop(1, rgba(colorC, 0.8));
    bg.fillStyle = radial;
    bg.fillRect(0, 0, WIDTH, HEIGHT);

    bg.setTransform(1, 0, 0, 1, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bgCanvas, 0, 0, WIDTH, HEIGHT);

    ctx.fillStyle = BG_OVERLAY;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawHeader(ctx, cover, title, artist) {
    const x = COVER_X;
    const y = (HEIGHT - COVER_SIZE) / 2 - 60;

    if (cover && cover.complete && cover.naturalWidth) {
        const side = Math.min(cover.naturalWidth, cover.naturalHeight);
        const sx = (cover.naturalWidth - side) / 2;
        const sy = (cover.naturalHeight - side) / 2;

        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, COVER_SIZE, COVER_SIZE, 18);
        ctx.clip();
        ctx.drawImage(cover, sx, sy, side, side, x, y, COVER_SIZE, COVER_SIZE);
        ctx.restore();
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.font = `700 36px ${FONT_STACK}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fitText(ctx, title, COVER_SIZE), x, y + COVER_SIZE + 56);

    ctx.font = `400 24px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillText(fitText(ctx, artist, COVER_SIZE), x, y + COVER_SIZE + 96);
}

function drawLyrics(ctx, layout, t) {
    const frameLines = computeFrameLayout(layout, t);
    const focus = getFocusIndex(layout.lines, t);
    const shift = LYRIC_CENTER_Y - getFocusY(frameLines, focus);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    frameLines.forEach((frameLine, k) => {
        const lineTop = shift + frameLine.top;
        if (lineTop + frameLine.height < -MAIN_LINE_HEIGHT || lineTop > HEIGHT + MAIN_LINE_HEIGHT) return;

        const line = frameLine.line;
        const distance = Math.abs(k - focus);
        const alpha = clamp(1.25 - 0.6 * distance, 0.3, 1);

        // Word-timed lines fill per span. Line-synced lines light up while they hold the scroll
        // focus: the highlight crossfades with the scroll, so it fades out as the focus leaves.
        let style;
        if (line.timed) {
            style = { alpha, fills: computeSpanFills(line.main.spans, t), brightness: 1 };
        } else {
            style = { alpha, fills: null, brightness: clamp(1 - distance, 0, 1) };
        }

        line.mainRows.forEach((row, r) => {
            const centerY = lineTop + r * MAIN_LINE_HEIGHT + MAIN_LINE_HEIGHT / 2;
            drawRow(ctx, row, centerY, MAIN_FONT, line.align, style);
        });

        frameLine.groups.forEach((placed) => {
            if (placed.height <= 0 || placed.fade <= 0) return;

            // The block is clipped to its animated height, like overflow: hidden on .bg-inner.
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, lineTop + placed.y, WIDTH, placed.height);
            ctx.clip();

            const fills = computeSpanFills(placed.group.spans, t);
            const adStyle = { alpha: alpha * ADLIB_ALPHA * placed.fade, fills, brightness: 1 };

            placed.group.rows.forEach((row, r) => {
                const centerY = lineTop + placed.y + r * ADLIB_LINE_HEIGHT + ADLIB_LINE_HEIGHT / 2;
                drawRow(ctx, row, centerY, AD_FONT, line.align, adStyle);
            });

            ctx.restore();
        });
    });
}

function drawRow(ctx, row, centerY, font, align, style) {
    ctx.font = font;

    let startX;
    if (align === 'right') {
        startX = LYRIC_RIGHT_X - row.width;
    } else if (align === 'left') {
        startX = LYRIC_LEFT_X;
    } else {
        startX = LYRIC_CENTER_X - row.width / 2;
    }

    row.items.forEach((item) => {
        item.spans.forEach((span) => {
            const x = startX + item.x + span.dx;

            if (style.fills) {
                drawSpanFill(ctx, span.text, x, centerY, span.w, style.fills[span.index], style.alpha);
            } else {
                ctx.fillStyle = `rgba(255, 255, 255, ${(style.alpha * (LINE_IDLE_ALPHA + (1 - LINE_IDLE_ALPHA) * style.brightness)).toFixed(3)})`;
                ctx.fillText(span.text, x, centerY);
            }
        });
    });
}

// Mirrors the CSS gradient on .word: lit up to a stop, a feathered band of width WORD_FEATHER,
// then unfilled. The stops are placed at the same positions the CSS calc() uses.
function drawSpanFill(ctx, text, x, y, width, fill, alpha) {
    const lit = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
    const dim = `rgba(255, 255, 255, ${(alpha * UNFILLED_ALPHA).toFixed(3)})`;

    if (fill <= 0) {
        ctx.fillStyle = dim;
        ctx.fillText(text, x, y);
        return;
    }

    if (fill >= 1) {
        ctx.fillStyle = lit;
        ctx.fillText(text, x, y);
        return;
    }

    const litEnd = fill * (1 + WORD_FEATHER) - WORD_FEATHER;
    const dimStart = fill * (1 + WORD_FEATHER);

    const gradient = ctx.createLinearGradient(x, 0, x + width, 0);
    gradient.addColorStop(0, lit);
    gradient.addColorStop(clamp(litEnd, 0, 1), lit);
    gradient.addColorStop(clamp(dimStart, 0, 1), dim);
    gradient.addColorStop(1, dim);

    ctx.fillStyle = gradient;
    ctx.fillText(text, x, y);
}

// ---------- helpers ----------

async function waitForQueue(encoder) {
    while (encoder.encodeQueueSize > QUEUE_LIMIT) {
        await new Promise((resolve) => setTimeout(resolve, 4));
    }
}

function fitText(ctx, text, maxWidth) {
    const value = String(text ?? '');
    if (ctx.measureText(value).width <= maxWidth) return value;

    let trimmed = value;
    while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
        trimmed = trimmed.slice(0, -1);
    }
    return `${trimmed}…`;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function easeInOutCubic(value) {
    return value < 0.5
        ? 4 * value * value * value
        : 1 - ((-2 * value + 2) ** 3) / 2;
}

function easeOutCubic(value) {
    return 1 - (1 - value) ** 3;
}

function hexToRgb(hex) {
    const clean = String(hex || '#000000').replace('#', '');
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    const n = Number.parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function darken(hex, amount) {
    const factor = clamp(amount, 0, 1);
    const { r, g, b } = hexToRgb(hex);
    const channel = (v) => Math.round(v * (1 - factor)).toString(16).padStart(2, '0');
    return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}