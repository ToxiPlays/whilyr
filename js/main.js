import { canExportVideo, exportLyricVideo, buildRenderFileName } from './export.js';

const audioUploadZone = document.querySelector('#audioUploadZone');
const audioFileInput = document.querySelector('#audioFileInput');
const coverArtFileInput = document.querySelector('#coverArtFileInput');
const lyricsUploadZone = document.querySelector('#lyricsUploadZone');
const lyricsFileInput = document.querySelector('#lyricsFileInput');
const lyricsContainer = document.querySelector('#lyricsContainer');
const coverArt = document.querySelector('.cover-art');
const songTitle = document.querySelector('.song-title');
const songArtist = document.querySelector('.song-artist');
const buttons = document.querySelector('.buttons');

const TTML_METADATA_NS = 'http://www.w3.org/ns/ttml#metadata';
const UNKNOWN_COVER_SRC = '/img/unk_cover.jpg';

const DEFAULT_BACKGROUND_PALETTE = ['#111111', '#111111', '#111111'];

const state = {
    audio: null,
    audioUrl: '',
    audioReady: false,
    lyricsReady: false,
    palette: [...DEFAULT_BACKGROUND_PALETTE],
    backgroundDarkness: 0,
    targetBackgroundDarkness: 0,
    bassLevel: 0,    
    bassAvg: 0,
    kickEnv: 0,
    lastFrameTime: 0,
    backgroundMotionId: null,
    audioContext: null,
    analyser: null,
    analyserData: null,
    mediaSource: null,
};

function hexToRgb(hex) {
    const value = String(hex || '#000000').trim();
    const clean = value.startsWith('#') ? value.slice(1) : value;
    const normalized = clean.length === 3
        ? clean.split('').map((char) => char + char).join('')
        : clean;

    const numeric = Number.parseInt(normalized, 16);
    if (!Number.isFinite(numeric) || normalized.length !== 6) {
        return { r: 0, g: 0, b: 0 };
    }

    return {
        r: (numeric >> 16) & 255,
        g: (numeric >> 8) & 255,
        b: numeric & 255,
    };
}

function rgbToHex({ r, g, b }) {
    return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToRgba({ r, g, b }, alpha) {
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(alpha).toFixed(3)})`;
}

function darkenHex(hex, amount) {
    const factor = clamp(amount, 0, 1);
    const { r, g, b } = hexToRgb(hex);
    return rgbToHex({
        r: Math.round(r * (1 - factor)),
        g: Math.round(g * (1 - factor)),
        b: Math.round(b * (1 - factor)),
    });
}

function getRelativeLuminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const channels = [r, g, b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });

    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function normalizePalette(colors) {
    const source = Array.isArray(colors) && colors.length ? colors : DEFAULT_BACKGROUND_PALETTE;
    const palette = source.slice(0, 3).map((color) => String(color || '').trim());

    while (palette.length < 3) {
        palette.push(DEFAULT_BACKGROUND_PALETTE[palette.length]);
    }

    return palette.map((color) => {
        const value = color.startsWith('#') ? color : `#${color}`;
        if (!/^#[0-9a-fA-F]{3,6}$/.test(value)) {
            return DEFAULT_BACKGROUND_PALETTE[0];
        }

        const normalized = value.length === 4
            ? value.split('').map((char, index) => index === 0 ? char : char + char).join('')
            : value;

        const luminance = getRelativeLuminance(normalized);
        if (luminance > 0.32) {
            const darkenBy = 1 - (0.32 / Math.max(luminance, 0.01));
            return darkenHex(normalized, Math.max(0, darkenBy));
        }

        return normalized.toLowerCase();
    });
}

function updateBackgroundTheme() {
    const palette = state.palette && state.palette.length ? state.palette : DEFAULT_BACKGROUND_PALETTE;
    const kick = state.kickEnv;
    const motionBoost = clamp(state.bassLevel * 0.4, 0, 0.4);
    const motionPhase = performance.now() * (0.00042 * (1 + motionBoost));

    // Rest slightly dark, flash to full palette brightness on the kick
    const REST_DARKNESS = 0.25;
    const darkness = REST_DARKNESS * (1 - kick);
    const [colorA, colorB, colorC] = palette.map((hex) => darkenHex(hex, darkness));

    const driftA = 38 + (Math.sin(motionPhase + 0.6) * 18);
    const driftB = 52 + (Math.cos(motionPhase * 0.8 + 1.4) * 16);

    // The bright core swells outward on the hit
    const stopMid = 45 + kick * 12;
    const stopEnd = 100;

    const ambientGradient = `radial-gradient(circle at ${driftA}% ${driftB}%, ${rgbToRgba(hexToRgb(colorA), 0.94)} 0%, ${rgbToRgba(hexToRgb(colorB), 0.88)} ${stopMid}%, ${rgbToRgba(hexToRgb(colorC), 0.8)} ${stopEnd}%)`;
    const baseGradient = `linear-gradient(135deg, ${darkenHex(colorA, 0.18)} 0%, ${darkenHex(colorB, 0.22)} 52%, ${darkenHex(colorC, 0.2)} 100%)`;

    document.body.style.setProperty('--ambient-gradient', ambientGradient);
    document.body.style.setProperty('--base-gradient', baseGradient);
    document.body.style.background = baseGradient;
    document.body.style.backgroundColor = darkenHex(colorB, 0.08);
}

function animateBackgroundTheme(now = performance.now()) {
    const dt = state.lastFrameTime ? Math.min((now - state.lastFrameTime) / 1000, 0.1) : 1 / 60;
    state.lastFrameTime = now;

    const playing = state.audio && !state.audio.paused && state.audioContext && state.analyser && state.analyserData;
    let onset = 0;

    if (playing) {
        state.analyser.getByteFrequencyData(state.analyserData);
        const nyquist = state.audioContext.sampleRate / 2;
        const len = state.analyserData.length;
        const startIndex = Math.max(1, Math.floor((40 / nyquist) * len));
        const endIndex = Math.min(len - 1, Math.ceil((120 / nyquist) * len));

        let bassTotal = 0;
        for (let i = startIndex; i <= endIndex; i += 1) bassTotal += state.analyserData[i];
        const bass = bassTotal / ((endIndex - startIndex + 1) * 255);

        // Onset = how far bass jumps above its recent (~0.3s) average
        const rise = bass - state.bassAvg;
        onset = clamp((rise - 0.03) / 0.15, 0, 1);

        // Slow follower: tracks the sustained level so only sudden rises count
        const follow = 1 - Math.exp(-dt / 0.3);
        state.bassAvg += (bass - state.bassAvg) * follow;
        state.bassLevel = bass;
    } else {
        state.bassAvg = 0;
        state.bassLevel = 0;
    }

    // Instant attack, exponential decay (~120ms time constant)
    state.kickEnv = Math.max(onset, state.kickEnv * Math.exp(-dt / 0.12));

    updateBackgroundTheme();
    state.backgroundMotionId = requestAnimationFrame(animateBackgroundTheme);
}

function setupAudioAnalysis() {
    if (!state.audio) {
        return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
        return;
    }

    if (!state.audioContext) {
        state.audioContext = new AudioContextClass();
    }

    if (!state.mediaSource) {
        state.mediaSource = state.audioContext.createMediaElementSource(state.audio);
        state.analyser = state.audioContext.createAnalyser();
        state.analyser.fftSize = 2048;
        state.analyser.smoothingTimeConstant = 0.3;
        state.analyserData = new Uint8Array(state.analyser.frequencyBinCount);
        state.mediaSource.connect(state.analyser);
        state.analyser.connect(state.audioContext.destination);

        state.kickFilter = state.audioContext.createBiquadFilter();
        state.kickFilter.type = 'lowpass';
        state.kickFilter.frequency.value = 150;
        state.kickFilter.Q.value = 0.7;

        state.kickAnalyser = state.audioContext.createAnalyser();
        state.kickAnalyser.fftSize = 256;            // ~6ms window at 44.1k
        state.kickAnalyser.smoothingTimeConstant = 0;
        state.kickData = new Float32Array(state.kickAnalyser.fftSize);

        state.mediaSource.connect(state.kickFilter);
        state.kickFilter.connect(state.kickAnalyser);
    }

    if (state.audioContext.state === 'suspended') {
        state.audioContext.resume();
    }

    if (state.backgroundMotionId === null) {
        state.backgroundMotionId = requestAnimationFrame(animateBackgroundTheme);
    }
}

function sanitizeMetadataText(value) {
    return String(value ?? '')
        .replace(/\u0000/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getNamespacedAttribute(element, attributeName, namespaceURI) {
    const directValue = element.getAttribute(attributeName);
    if (directValue !== null) {
        return directValue;
    }

    if (namespaceURI) {
        const localName = attributeName.includes(':') ? attributeName.split(':').pop() : attributeName;
        return element.getAttributeNS(namespaceURI, localName);
    }

    return null;
}

function parseTimestamp(value) {
    if (value === null || value === undefined) {
        return null;
    }

    const raw = String(value).trim();
    if (!raw) {
        return null;
    }

    if (!Number.isNaN(Number(raw))) {
        return Number(raw);
    }

    const segments = raw.split(':').map((segment) => segment.trim()).filter(Boolean);

    if (segments.length === 1) {
        return Number(segments[0]);
    }

    if (segments.length === 2) {
        const minutes = Number(segments[0]);
        const seconds = Number(segments[1]);
        return Number.isFinite(minutes) && Number.isFinite(seconds) ? (minutes * 60) + seconds : null;
    }

    if (segments.length >= 3) {
        const hours = Number(segments[0]);
        const minutes = Number(segments[1]);
        const seconds = Number(segments[2]);
        return Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds)
            ? (hours * 3600) + (minutes * 60) + seconds
            : null;
    }

    return null;
}

function updateButtonsVisibility() {
    const shouldShow = state.audioReady && state.lyricsReady;
    buttons.classList.toggle('hidden', !shouldShow);
}

function applySongMetadata(metadata) {
    const title = sanitizeMetadataText(metadata.title);
    const artist = sanitizeMetadataText(metadata.artist);
    const fallbackTitle = title || 'Song Title';
    const fallbackArtist = artist || 'Song Artist';

    songTitle.textContent = fallbackTitle;
    songArtist.textContent = fallbackArtist;

    const titleHasValue = !!title && fallbackTitle !== 'Song Title';
    const artistHasValue = !!artist && fallbackArtist !== 'Song Artist';
    const shouldBeEditable = !titleHasValue || !artistHasValue;

    songTitle.setAttribute('contenteditable', String(shouldBeEditable));
    songArtist.setAttribute('contenteditable', String(shouldBeEditable));

    if (shouldBeEditable) {
        songTitle.focus?.();
    }

    const imageSource = metadata.coverDataUrl || UNKNOWN_COVER_SRC;
    coverArt.src = imageSource;
    coverArt.alt = title || 'Album cover art';

    coverArt.classList.remove('hidden');
    songTitle.classList.remove('hidden');
    songArtist.classList.remove('hidden');
}

function hasMeaningfulText(value, fallbackText) {
    const text = sanitizeMetadataText(value);
    if (!text) {
        return false;
    }

    return text.toLowerCase() !== fallbackText.toLowerCase();
}

function syncManualTextState() {
    const titleValue = sanitizeMetadataText(songTitle.textContent);
    const artistValue = sanitizeMetadataText(songArtist.textContent);
    const titleReady = hasMeaningfulText(titleValue, 'Song Title');
    const artistReady = hasMeaningfulText(artistValue, 'Song Artist');

    const shouldEdit = !(titleReady && artistReady);
    songTitle.setAttribute('contenteditable', String(shouldEdit));
    songArtist.setAttribute('contenteditable', String(shouldEdit));
}

function getDataUrlFromBytes(bytes, mimeType) {
    const binary = Array.from(bytes).map((byte) => String.fromCharCode(byte)).join('');
    return `data:${mimeType || 'image/png'};base64,${btoa(binary)}`;
}

function decodeTextPayload(bytes, encoding) {
    if (!bytes || !bytes.length) {
        return '';
    }

    if (encoding === 0x00) {
        return new TextDecoder('iso-8859-1').decode(bytes);
    }

    if (encoding === 0x01) {
        const view = new Uint8Array(bytes);
        if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) {
            return new TextDecoder('utf-16le').decode(bytes.slice(2));
        }
        if (view.length >= 2 && view[0] === 0xfe && view[1] === 0xff) {
            return new TextDecoder('utf-16be').decode(bytes.slice(2));
        }
        return new TextDecoder('utf-16le').decode(bytes);
    }

    if (encoding === 0x02) {
        return new TextDecoder('utf-16be').decode(bytes);
    }

    if (encoding === 0x03) {
        return new TextDecoder('utf-8').decode(bytes);
    }

    return new TextDecoder('utf-8').decode(bytes);
}

function parseId3TextFrame(frameData) {
    if (!frameData || frameData.length < 2) {
        return '';
    }

    const encoding = frameData[0];
    let payload = frameData.slice(1);
    let textStart = 0;

    if (encoding === 0x01 || encoding === 0x02) {
        const bomLength = payload.length >= 2 && payload[0] === 0xff && payload[1] === 0xfe ? 2 : 0;
        textStart = bomLength;
    }

    const nullIndex = payload.indexOf(0x00, textStart);
    if (nullIndex >= 0) {
        payload = payload.slice(0, nullIndex);
    }

    return decodeTextPayload(payload, encoding).replace(/\uFFFD/g, '').trim();
}

function parseId3Tags(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 10 || String.fromCharCode(...bytes.slice(0, 3)) !== 'ID3') {
        return { title: '', artist: '', coverDataUrl: '' };
    }

    const majorVersion = bytes[3];
    const minorVersion = bytes[4];
    const flags = bytes[5];
    const syncSafeSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const tagEnd = 10 + syncSafeSize;

    let title = '';
    let artist = '';
    let coverDataUrl = '';

    for (let offset = 10; offset + 10 <= Math.min(bytes.length, tagEnd);) {
        const frameId = String.fromCharCode(...bytes.slice(offset, offset + 4));
        if (frameId === '\u0000\u0000\u0000\u0000') {
            break;
        }

        const frameSizeBytes = bytes.slice(offset + 4, offset + 8);
        const frameSize = frameSizeBytes.reduce((sum, byte, index) => sum + ((byte & 0xff) << ((3 - index) * 8)), 0);
        const frameHeaderSize = 10;

        if (!Number.isFinite(frameSize) || frameSize < 0) {
            break;
        }

        const frameData = bytes.slice(offset + frameHeaderSize, offset + frameHeaderSize + frameSize);

        if (frameId === 'TIT2') {
            title = parseId3TextFrame(frameData);
        } else if (frameId === 'TPE1') {
            artist = parseId3TextFrame(frameData);
        } else if (frameId === 'APIC') {
            let mimeStart = 0;
            while (mimeStart < frameData.length && frameData[mimeStart] !== 0x00) {
                mimeStart += 1;
            }

            if (mimeStart < frameData.length) {
                const mimeType = new TextDecoder('iso-8859-1').decode(frameData.slice(0, mimeStart));
                const imageStart = mimeStart + 2;
                const imageData = frameData.slice(imageStart);

                if (imageData.length > 0) {
                    coverDataUrl = getDataUrlFromBytes(imageData, mimeType || 'image/jpeg');
                }
            }
        }

        offset += frameHeaderSize + frameSize;
    }

    if (majorVersion >= 3 && (flags & 0x10) === 0x10) {
        // Footer present; skip a few bytes after the main tag.
    }

    return { title, artist, coverDataUrl };
}

function parseMp4Metadata(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const result = { title: '', artist: '', coverDataUrl: '' };

    function readU32(offset) {
        return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    }

    function readAtom(offset, limit) {
        if (offset + 8 > limit) return null;
        let size = readU32(offset);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > limit) return null;
            size = readU32(offset + 8) * 4294967296 + readU32(offset + 12); // 64-bit size
            headerSize = 16;
        } else if (size === 0) {
            size = limit - offset; // atom runs to end of parent
        }
        if (size < headerSize || offset + size > limit) return null;
        const type = String.fromCharCode(
            bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]
        );
        return { size, type, start: offset, bodyStart: offset + headerSize, end: offset + size };
    }

    function findChild(parentStart, parentEnd, type) {
        let cursor = parentStart;
        while (cursor + 8 <= parentEnd) {
            const atom = readAtom(cursor, parentEnd);
            if (!atom) return null;
            if (atom.type === type) return atom;
            cursor = atom.end;
        }
        return null;
    }

    // Path: moov > udta > meta > ilst (meta has 4 extra bytes of version/flags)
    const moov = findChild(0, bytes.length, 'moov');
    const udta = moov && findChild(moov.bodyStart, moov.end, 'udta');
    const meta = udta && findChild(udta.bodyStart, udta.end, 'meta');
    const ilst = meta && findChild(meta.bodyStart + 4, meta.end, 'ilst');
    if (!ilst) return result;

    // Each ilst item wraps a 'data' atom: [size][data][version+flags 4B][locale 4B][payload...]
    function readDataPayload(item) {
        const data = findChild(item.bodyStart, item.end, 'data');
        if (!data) return null;
        const flags = readU32(data.bodyStart) & 0xffffff; // 13 = JPEG, 14 = PNG, 1 = UTF-8 text
        return { flags, payload: bytes.subarray(data.bodyStart + 8, data.end) };
    }

    let cursor = ilst.bodyStart;
    while (cursor + 8 <= ilst.end) {
        const item = readAtom(cursor, ilst.end);
        if (!item) break;

        if (item.type === '\u00a9nam' || item.type === '\u00a9ART' || item.type === 'covr') {
            const entry = readDataPayload(item);
            if (entry && entry.payload.length) {
                if (item.type === '\u00a9nam') {
                    result.title = new TextDecoder('utf-8').decode(entry.payload);
                } else if (item.type === '\u00a9ART') {
                    result.artist = new TextDecoder('utf-8').decode(entry.payload);
                } else if (!result.coverDataUrl) {
                    const p = entry.payload;
                    const isPng = entry.flags === 14 || (p[0] === 0x89 && p[1] === 0x50);
                    result.coverDataUrl = getDataUrlFromBytes(p, isPng ? 'image/png' : 'image/jpeg');
                }
            }
        }
        cursor = item.end;
    }

    return result;
}

function parseAudioMetadata(file) {
    return file.arrayBuffer().then((buffer) => {
        const baseMetadata = { title: '', artist: '', coverDataUrl: '' };
        const id3Metadata = parseId3Tags(buffer);
        if (id3Metadata.title || id3Metadata.artist || id3Metadata.coverDataUrl) {
            return { ...baseMetadata, ...id3Metadata };
        }

        const mp4Metadata = parseMp4Metadata(buffer);
        if (mp4Metadata.title || mp4Metadata.artist || mp4Metadata.coverDataUrl) {
            return { ...baseMetadata, ...mp4Metadata };
        }

        return baseMetadata;
    }).catch(() => ({ title: '', artist: '', coverDataUrl: '' }));
}

let lyricRafId = null;

function lyricLoop() {
    updateLyricState();
    lyricRafId = requestAnimationFrame(lyricLoop);
}

function startLyricLoop() {
    if (lyricRafId === null) lyricRafId = requestAnimationFrame(lyricLoop);
}

function stopLyricLoop() {
    if (lyricRafId !== null) {
        cancelAnimationFrame(lyricRafId);
        lyricRafId = null;
    }
    updateLyricState(); 
}

function getAudioElement() {
    if (!state.audio) {
        state.audio = new Audio();
        state.audio.preload = 'auto';
        state.audio.addEventListener('loadedmetadata', () => {
            state.audioReady = true;
            updateButtonsVisibility();
        });
        state.audio.addEventListener('timeupdate', () => {
            if (state.audio.paused) updateLyricState();
        });
        state.audio.addEventListener('seeked', updateLyricState);
        state.audio.addEventListener('play', () => {
            setupAudioAnalysis();
            startLyricLoop();
            buttons.querySelector('[data-action="play"]').style.opacity = '0.65';
            buttons.querySelector('[data-action="pause"]').style.opacity = '1';
        });
        state.audio.addEventListener('pause', () => {
            stopLyricLoop();
            buttons.querySelector('[data-action="play"]').style.opacity = '1';
            buttons.querySelector('[data-action="pause"]').style.opacity = '0.65';
        });
        state.audio.addEventListener('ended', () => {
            stopLyricLoop();
            buttons.querySelector('[data-action="play"]').style.opacity = '1';
            buttons.querySelector('[data-action="pause"]').style.opacity = '0.65';
        });
    }

    return state.audio;
}

function isUnknownCoverArt() {
    if (!coverArt || !coverArt.src) {
        return false;
    }

    try {
        const absoluteUrl = new URL(coverArt.src, window.location.href).href;
        return absoluteUrl.endsWith('/img/unk_cover.png');
    } catch (error) {
        return String(coverArt.src).includes('/img/unk_cover.png');
    }
}

function setCoverFallback(metadata) {
    if (metadata.coverDataUrl) {
        coverArt.src = metadata.coverDataUrl;
        return;
    }

    coverArt.src = UNKNOWN_COVER_SRC;
    coverArt.classList.add('placeholder');
}

async function handleCustomCoverFile(file) {
    if (!file || !file.type.startsWith('image/')) {
        return;
    }

    if (state.customCoverUrl) {
        URL.revokeObjectURL(state.customCoverUrl);
    }

    state.customCoverUrl = URL.createObjectURL(file);
    coverArt.classList.remove('placeholder');
    coverArt.src = state.customCoverUrl;
    coverArt.alt = 'Custom album cover art';
    await applyProminentPalette(state.customCoverUrl);
}

async function applyProminentPalette(dataUrl) {
    try {
        if (!dataUrl || typeof window === 'undefined' || !window.colorjs || !window.colorjs.prominent) {
            state.palette = [...DEFAULT_BACKGROUND_PALETTE];
            updateBackgroundTheme();
            return;
        }

        const colors = await window.colorjs.prominent(dataUrl, { amount: 3, format: 'hex' });
        state.palette = normalizePalette(colors);
        updateBackgroundTheme();
    } catch (error) {
        state.palette = [...DEFAULT_BACKGROUND_PALETTE];
        updateBackgroundTheme();
    }
}

async function handleAudioFile(file) {
    if (!file) {
        return;
    }

    const audio = getAudioElement();
    if (state.audioUrl) {
        URL.revokeObjectURL(state.audioUrl);
    }

    state.audioUrl = URL.createObjectURL(file);
    audio.src = state.audioUrl;
    audio.load();
    setupAudioAnalysis();

    const metadata = await parseAudioMetadata(file);
    const title = sanitizeMetadataText(metadata.title);
    const artist = sanitizeMetadataText(metadata.artist);

    if (!title && !artist) {
        songTitle.textContent = 'Song Title';
        songArtist.textContent = 'Song Artist';
        songTitle.setAttribute('contenteditable', 'true');
        songArtist.setAttribute('contenteditable', 'true');
    } else {
        songTitle.textContent = title || 'Song Title';
        songArtist.textContent = artist || 'Song Artist';
        const shouldEdit = !title || !artist;
        songTitle.setAttribute('contenteditable', String(shouldEdit));
        songArtist.setAttribute('contenteditable', String(shouldEdit));
    }

    if (!metadata.coverDataUrl) {
        coverArt.classList.add('placeholder');
        setCoverFallback(metadata);
        state.palette = [...DEFAULT_BACKGROUND_PALETTE];
        updateBackgroundTheme();
    } else {
        coverArt.src = metadata.coverDataUrl;
        await applyProminentPalette(metadata.coverDataUrl);
    }

    coverArt.alt = title || 'Album cover art';
    coverArt.classList.remove('hidden');
    songTitle.classList.remove('hidden');
    songArtist.classList.remove('hidden');
    audioUploadZone.classList.add('hidden');

    songTitle.addEventListener('input', () => {
        songTitle.setAttribute('contenteditable', 'true');
        songArtist.setAttribute('contenteditable', 'true');
    });
    songArtist.addEventListener('input', () => {
        songTitle.setAttribute('contenteditable', 'true');
        songArtist.setAttribute('contenteditable', 'true');
    });
}

function openAudioFilePicker() {
    audioFileInput.click();
}

function centerTop(element, scroller) {
    const containerHeight = scroller.clientHeight;
    const offsetTop = element.offsetTop - scroller.offsetTop;
    return Math.max(0, offsetTop - containerHeight / 2 + element.offsetHeight / 2);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function easeOutCubic(value) {
    return 1 - Math.pow(1 - value, 3);
}

function easeInOutCubic(value) {
    if (value < 0.5) {
        return 4 * Math.pow(value, 3);
    }

    return 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function getLineDisplayRange(line, nextLine) {
    const start = Number(line.dataset.start || 0);
    const rawEnd = Number(line.dataset.end || NaN);

    if (Number.isFinite(rawEnd) && rawEnd > start) {
        return { start, end: rawEnd };
    }

    const inferredEnd = nextLine ? Number(nextLine.dataset.start || start) : start;
    return { start, end: Math.max(start, inferredEnd) };
}

function getEffectiveLineGap(currentLine, nextLine) {
    const currentRange = getLineDisplayRange(currentLine, nextLine);
    const currentEnd = currentRange.end;
    const nextStart = Number(nextLine?.dataset.start || 0);
    const nextEndRaw = Number(nextLine?.dataset.end || NaN);
    const nextEnd = Number.isFinite(nextEndRaw) && nextEndRaw > nextStart ? nextEndRaw : nextStart;

    const effectiveNextStart = Math.max(nextStart, currentEnd);
    const effectiveNextEnd = Math.max(nextEnd, effectiveNextStart);

    return {
        currentEnd,
        nextStart: effectiveNextStart,
        nextEnd: effectiveNextEnd,
        gap: Math.max(0, effectiveNextStart - currentEnd),
        nextDuration: Math.max(0, effectiveNextEnd - effectiveNextStart),
    };
}

function getLineScrollPlan(currentLine, nextLine) {
    if (!currentLine || !nextLine) {
        return null;
    }

    const { currentEnd, nextStart, gap, nextDuration } = getEffectiveLineGap(currentLine, nextLine);

    if (gap <= 0.3) {
        return {
            start: currentEnd,
            end: nextStart,
            easing: easeInOutCubic,
        };
    }

    if (gap > 0.3 && gap <= 0.9) {
        return {
            start: nextStart,
            end: nextStart + Math.max(0.15, 0.15 * nextDuration),
            easing: easeOutCubic,
        };
    }

    if (gap >= 0.9 && gap <= 5) {
        return {
            start: currentEnd + (0.15 * gap),
            end: currentEnd + (0.9 * gap),
            easing: easeInOutCubic,
        };
    }

    return null;
}

function scrollToCurrentLine() {
    const lyricLines = Array.from(lyricsContainer.querySelectorAll('p'));
    if (!lyricLines.length) {
        return;
    }

    const currentTime = state.audio ? state.audio.currentTime : 0;
    const activeLine = lyricLines.find((line) => line.classList.contains('current'))
        || lyricLines.slice().reverse().find((line) => Number(line.dataset.start || 0) <= currentTime)
        || lyricLines[0];

    const activeIndex = lyricLines.indexOf(activeLine);
    const nextLine = lyricLines[activeIndex + 1] || null;
    const plan = getLineScrollPlan(activeLine, nextLine);

    if (!plan) {
        const targetScrollTop = centerTop(activeLine, lyricsContainer);
        lyricsContainer.scrollTop = targetScrollTop;
        return;
    }

    if (currentTime < plan.start) {
        const targetScrollTop = centerTop(activeLine, lyricsContainer);
        if (lyricsContainer.scrollTop === 0 || Math.abs(lyricsContainer.scrollTop - targetScrollTop) > 1) {
            lyricsContainer.scrollTop = targetScrollTop;
        }
        return;
    }

    if (currentTime >= plan.end || !nextLine) {
        const targetLine = nextLine || activeLine;
        lyricsContainer.scrollTop = centerTop(targetLine, lyricsContainer);
        return;
    }

    const progress = clamp((currentTime - plan.start) / (plan.end - plan.start), 0, 1);
    const easedProgress = plan.easing(progress);
    const fromTop = centerTop(activeLine, lyricsContainer);
    const toTop = centerTop(nextLine, lyricsContainer);

    lyricsContainer.scrollTop = fromTop + ((toTop - fromTop) * easedProgress);
}

const WORD_GAP_EPSILON = 0.02;

// Per-word fill (0..1) for the colour sweep. Each word gets its own gradient, so the sweep
// stays correct when a line wraps onto several rows (a single line-wide gradient can't do that).
function computeWordFills(words, t) {
    return words.map((w, i) => {
        const p = clamp((t - w.start) / Math.max(w.end - w.start, 0.001), 0, 1);
        const next = words[i + 1];
        const hasGap = next && (next.start - w.end) > WORD_GAP_EPSILON;
        if (!hasGap) return p;
        if (t < next.start) return 0.8 * p;
        const nextDur = Math.max(next.end - next.start, 0.001);
        return 0.9 + 0.1 * clamp((t - next.start) / (nextDur * 0.25), 0, 1);
    });
}

// phase: 'live' (animate from currentTime), 'past' (fully sung), 'future' (reset)
function applyWordSync(line, currentTime, phase) {
    line._tracks.forEach((track) => {
        // Ad-lib rows stay open once revealed (so they keep displaying); collapse again only on seek-back.
        if (track.rowEl) {
            track.rowEl.classList.toggle('revealed', phase === 'past' || currentTime >= track.revealAt);
        }

        const words = track.words;
        if (!words.length) return;
        const fills = phase === 'live' ? computeWordFills(words, currentTime) : null;

        words.forEach((w, i) => {
            let fill, y;
            if (phase === 'past') {
                fill = 1; y = 0;
            } else if (phase === 'future') {
                fill = 0; y = 2;
            } else {
                fill = fills[i];
                const p = clamp((currentTime - w.start) / Math.max(w.end - w.start, 0.001), 0, 1);
                y = currentTime < w.start ? 2 : (1 - easeOutCubic(p)) * 2;
            }
            w.el.style.setProperty('--fill', `${(fill * 100).toFixed(2)}%`);
            w.el.style.transform = `translateY(${y.toFixed(3)}px)`;
        });
    });
}

function updateLyricState() {
    if (!state.audio || !lyricsContainer.querySelectorAll('p').length) {
        return;
    }

    const currentTime = state.audio.currentTime;
    const lyricLines = Array.from(lyricsContainer.querySelectorAll('p'));
    let activeLine = null;

    lyricLines.forEach((line, index) => {
        const nextLine = lyricLines[index + 1] || null;
        const { start: begin, end } = getLineDisplayRange(line, nextLine);
        const isCurrent = currentTime >= begin && currentTime < end;
        const isPast = currentTime >= end;

        line.classList.toggle('current', isCurrent);
        line.classList.toggle('past', isPast);

        if (line._tracks) {
            const phase = isCurrent ? 'live' : (isPast ? 'past' : 'future');
            // An ad-lib can open slightly *before* its line starts, so a future line needs to notice that.
            const pre = phase === 'future' && currentTime >= line._earliestReveal;
            if (phase === 'live' || line._wsPhase !== phase || pre !== line._wsPre) {
                applyWordSync(line, currentTime, phase);
            }
            line._wsPhase = phase;
            line._wsPre = pre;
        }

        if (isCurrent && !activeLine) {
            activeLine = line;
        }
    });

    scrollToCurrentLine();
}

function isSupportedLyricFile(file) {
    if (!file) {
        return false;
    }

    const extension = file.name.split('.').pop()?.toLowerCase();
    const fileType = file.type || '';
    return ['ttml', 'xml', 'srt', 'lrc'].includes(extension)
        || fileType.includes('xml')
        || fileType.includes('ttml')
        || fileType.includes('srt')
        || fileType.includes('lrc');
}

function buildSimpleLyricLine(start, end, text) {
    const cleanedText = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (start === null || !Number.isFinite(start) || !cleanedText) {
        return null;
    }

    const lyricLine = document.createElement('p');
    lyricLine.setAttribute('data-start', String(start));
    lyricLine.setAttribute('data-end', String(Number.isFinite(end) ? end : start + 2));
    lyricLine.textContent = cleanedText;
    return lyricLine;
}

function parseTimecodeToSeconds(rawValue) {
    if (rawValue === null || rawValue === undefined) {
        return null;
    }

    const value = String(rawValue).trim().replace(/^[\[(]|[\])]$/g, '');
    if (!value) {
        return null;
    }

    const normalized = value.replace(',', '.');
    const segments = normalized.split(':').map((segment) => segment.trim()).filter(Boolean);
    if (!segments.length) {
        return null;
    }

    const last = segments[segments.length - 1];
    const secondsMatch = last.match(/^([0-9]+)(?:\.([0-9]{1,3}))?$/);
    if (!secondsMatch) {
        return null;
    }

    const wholeSeconds = Number(segments[segments.length - 1].split(/[.]/)[0]);
    const fractional = Number(`0.${segments[segments.length - 1].split('.')[1] || '0'}`);
    let seconds = Number.isFinite(wholeSeconds) ? wholeSeconds : 0;
    seconds += Number.isFinite(fractional) ? fractional : 0;

    if (segments.length === 1) {
        return Number.isFinite(seconds) ? seconds : null;
    }

    if (segments.length === 2) {
        const minutes = Number(segments[0]);
        return Number.isFinite(minutes) ? (minutes * 60) + seconds : null;
    }

    const minutes = Number(segments[segments.length - 2]);
    const hours = Number(segments[segments.length - 3] ?? 0);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
        return null;
    }

    return (hours * 3600) + (minutes * 60) + seconds;
}

function parseSrtLyrics(srtText) {
    const blocks = String(srtText || '').split(/\r?\n\s*\r?\n/).map((block) => block.trim()).filter(Boolean);
    const lyricLines = [];

    blocks.forEach((block) => {
        const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const timingLine = lines.find((line) => /-->/.test(line));
        if (!timingLine) {
            return;
        }

        const match = timingLine.match(/(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})/);
        if (!match) {
            return;
        }

        const start = parseTimecodeToSeconds(match[1]);
        const end = parseTimecodeToSeconds(match[2]);
        const text = lines
            .filter((line) => line !== timingLine && !/^\d+$/.test(line) && !/-->/.test(line))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

        const lineElement = buildSimpleLyricLine(start, end, text);
        if (lineElement) {
            lyricLines.push(lineElement);
        }
    });

    if (!lyricLines.length) {
        throw new Error('No synced lyric lines were found in this SRT file.');
    }

    return lyricLines;
}

function parseLrcLyrics(lrcText) {
    const lines = String(lrcText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const lyricLines = [];

    lines.forEach((line) => {
        const matches = [...line.matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]/g)];
        if (!matches.length) {
            return;
        }

        const text = line.replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
        if (!text) {
            return;
        }

        matches.forEach((match) => {
            const start = parseTimecodeToSeconds(match[1]);
            const lineElement = buildSimpleLyricLine(start, start + 2, text);
            if (lineElement) {
                lyricLines.push(lineElement);
            }
        });
    });

    if (!lyricLines.length) {
        throw new Error('No synced lyric lines were found in this LRC file.');
    }

    return lyricLines;
}

function parseLyricsFile(text, fileName) {
    const extension = fileName?.split('.').pop()?.toLowerCase();

    if (extension === 'srt') {
        return parseSrtLyrics(text);
    }

    if (extension === 'lrc') {
        return parseLrcLyrics(text);
    }

    return parseTtmlLyrics(text);
}

// Ad-libs show up this long before they are sung (or when their line starts, whichever is first).
const BG_REVEAL_LEAD = 0.5;

// Walks a <p>'s real childNodes. A text node between two spans = word boundary (space);
// spans with NO text node between them are syllables of one word and share a .word-group.
// Each ttm:role="x-bg" wrapper becomes its own collapsible row *below* the main line.
// Returns tracks: the main line track, then one track per ad-lib row. Words are tracked per row
// so the gap/90% sweep logic never mixes main words with ad-lib words.
function buildWordNodes(lineElement, lineStart) {
    const fragment = document.createDocumentFragment();
    const mainTrack = { words: [], rowEl: null, revealAt: -Infinity };
    const bgTracks = [];

    const isBgRole = (node) => node.getAttribute('ttm:role') === 'x-bg'
        || node.getAttributeNS(TTML_METADATA_NS, 'role') === 'x-bg';

    const collect = (parent, container, track, isBg) => {
        let group = null;
        const flush = () => {
            if (group) {
                container.appendChild(group);
                group = null;
            }
        };

        const addSpan = (spanEl) => {
            const start = parseTimestamp(spanEl.getAttribute('begin'));
            if (start === null) return;
            const parsedEnd = parseTimestamp(spanEl.getAttribute('end'));
            const end = parsedEnd !== null && parsedEnd > start ? parsedEnd : start;

            let text = spanEl.textContent ?? '';
            if (isBg) text = text.replace(/^\(/, '').replace(/\)$/, '');
            if (!text.trim()) return;

            if (!group) {
                group = document.createElement('span');
                group.className = 'word-group';
            }

            const el = document.createElement('span');
            el.className = 'word';
            el.textContent = text;
            el.style.setProperty('--fill', '0%');
            el.style.transform = 'translateY(2px)';
            group.appendChild(el);

            track.words.push({ el, start, end });
        };

        Array.from(parent.childNodes).forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                // ANY text node between spans is a word boundary, even whitespace-only ones.
                flush();
                const t = node.textContent ?? '';
                if (/\S/.test(t)) {
                    container.appendChild(document.createTextNode(t));
                } else if (container.lastChild && container.lastChild.nodeType !== Node.TEXT_NODE) {
                    container.appendChild(document.createTextNode(' '));
                }
                return;
            }

            if (node.nodeType !== Node.ELEMENT_NODE || node.localName !== 'span') return;

            // Ad-lib wrapper: pull it out of the main flow into its own row.
            if (!isBg && isBgRole(node)) {
                flush();
                const rowEl = document.createElement('span');
                rowEl.className = 'bg-line';
                const inner = document.createElement('span');
                inner.className = 'bg-inner';
                rowEl.appendChild(inner);

                const bgTrack = { words: [], rowEl, revealAt: Infinity };
                if (node.querySelector('span[begin]')) {
                    collect(node, inner, bgTrack, true);   // walk nested spans; wrapper text is NOT emitted again
                } else {
                    // wrapper is itself the timed span: feed a role-less clone through the normal path
                    const holder = document.createElement('span');
                    const clone = node.cloneNode(true);
                    clone.removeAttribute('ttm:role');
                    holder.appendChild(clone);
                    collect(holder, inner, bgTrack, true);
                }

                if (bgTrack.words.length) {
                    const first = Math.min(...bgTrack.words.map((w) => w.start));
                    bgTrack.revealAt = Math.min(first - BG_REVEAL_LEAD, lineStart);
                    bgTracks.push(bgTrack);
                }
                return;
            }

            // Plain wrapper containing nested timed spans: walk into it, don't also emit its text.
            if (node.querySelector('span[begin]')) {
                flush();
                collect(node, container, track, isBg);
                return;
            }

            addSpan(node);
        });

        flush();
    };

    // An ad-lib wrapper with no nested spans is itself the timed span: handle by wrapping it.
    collect(lineElement, fragment, mainTrack, false);

    // Rows go after all main-line content.
    bgTracks.forEach((t) => fragment.appendChild(t.rowEl));

    return { fragment, tracks: [mainTrack, ...bgTracks] };
}

function buildLyricLine(lineElement) {
    const start = parseTimestamp(lineElement.getAttribute('begin'));
    const end = parseTimestamp(lineElement.getAttribute('end'));
    const text = lineElement.textContent?.trim();

    if (start === null || !text) {
        return null;
    }

    const lyricLine = document.createElement('p');
    lyricLine.setAttribute('data-start', String(start));
    lyricLine.setAttribute('data-end', String(end ?? start));

    const agentValue = getNamespacedAttribute(lineElement, 'ttm:agent', TTML_METADATA_NS)
        ?? getNamespacedAttribute(lineElement, 'agent', TTML_METADATA_NS)
        ?? lineElement.getAttribute('agent');

    if (agentValue === 'v2') {
        lyricLine.classList.add('duet-agent');
    }

    const hasWordSpans = Array.from(lineElement.querySelectorAll('span[begin]')).length > 0;
    if (hasWordSpans) {
        const { fragment, tracks } = buildWordNodes(lineElement, start);
        if (tracks.some((t) => t.words.length)) {
            lyricLine.classList.add('word-sync');
            lyricLine.appendChild(fragment);
            lyricLine._tracks = tracks;
            lyricLine._earliestReveal = Math.min(...tracks.filter((t) => t.rowEl).map((t) => t.revealAt), Infinity);
            lyricLine._wsPhase = null;
            lyricLine._wsPre = false;
            return lyricLine;
        }
    }

    lyricLine.textContent = text;
    return lyricLine;
}

function parseTtmlLyrics(xmlText) {
    const parser = new DOMParser();
    const document = parser.parseFromString(xmlText, 'application/xml');
    const parseError = document.querySelector('parsererror');

    if (parseError) {
        throw new Error('Unable to parse the TTML file.');
    }

    const lyricNodes = [...document.querySelectorAll('p[begin]')];
    const lyricLines = lyricNodes
        .map(buildLyricLine)
        .filter(Boolean);

    if (!lyricLines.length) {
        throw new Error('No synced lyric lines were found in this TTML file.');
    }

    return lyricLines;
}

async function handleSelectedFile(file) {
    if (!file || !isSupportedLyricFile(file)) {
        return;
    }

    try {
        const fileText = await file.text();
        const lyricLines = parseLyricsFile(fileText, file.name);

        lyricsContainer.innerHTML = '';
        lyricLines.forEach((line) => lyricsContainer.appendChild(line));

        lyricsUploadZone.classList.add('hidden');
        lyricsContainer.classList.remove('hidden');
        state.lyricsReady = true;
        updateButtonsVisibility();
    } catch (error) {
        console.error(error);
        window.alert('That file does not appear to be a valid lyric file. Supported formats: TTML, SRT, and LRC.');
    }
}

let isRendering = false;

async function renderLyricVideo(trigger) {
    if (isRendering) {
        return;
    }

    const lyricElements = Array.from(lyricsContainer.querySelectorAll('p[data-start]'));
    if (!state.audioUrl || !lyricElements.length) {
        return;
    }

    if (!canExportVideo()) {
        window.alert('This browser cannot encode MP4 video. Try a recent version of Chrome, Edge, or Safari.');
        return;
    }

    isRendering = true;
    const previousOpacity = trigger.style.opacity;
    trigger.style.opacity = '0.4';

    try {
        const blob = await exportLyricVideo({
            audioUrl: state.audioUrl,
            lyricElements,
            palette: state.palette,
            coverImage: coverArt,
            title: songTitle.textContent,
            artist: songArtist.textContent,
            onProgress: (fraction) => {
                trigger.title = `Rendering ${Math.round(fraction * 100)}%`;
            },
        });

        downloadBlob(blob, buildRenderFileName(songTitle.textContent, songArtist.textContent));
    } catch (error) {
        console.error(error);
        window.alert('The lyric video could not be rendered. Check the console for details.');
    } finally {
        isRendering = false;
        trigger.style.opacity = previousOpacity || '1';
        trigger.title = 'Render video';
    }
}

function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openFilePicker() {
    lyricsFileInput.click();
}

coverArt.addEventListener('click', () => {
    if (isUnknownCoverArt()) {
        coverArtFileInput?.click();
    }
});

coverArtFileInput?.addEventListener('change', async (event) => {
    const [file] = event.target.files;
    await handleCustomCoverFile(file);
    event.target.value = '';
});

audioUploadZone.addEventListener('click', openAudioFilePicker);
audioUploadZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openAudioFilePicker();
    }
});

audioUploadZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    audioUploadZone.classList.add('dragover');
});

audioUploadZone.addEventListener('dragleave', () => {
    audioUploadZone.classList.remove('dragover');
});

audioUploadZone.addEventListener('drop', (event) => {
    event.preventDefault();
    audioUploadZone.classList.remove('dragover');

    const [file] = event.dataTransfer.files;
    handleAudioFile(file);
});

audioFileInput.addEventListener('change', (event) => {
    const [file] = event.target.files;
    handleAudioFile(file);
    event.target.value = '';
});

lyricsUploadZone.addEventListener('click', openFilePicker);
lyricsUploadZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openFilePicker();
    }
});

lyricsUploadZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    lyricsUploadZone.classList.add('dragover');
});

lyricsUploadZone.addEventListener('dragleave', () => {
    lyricsUploadZone.classList.remove('dragover');
});

lyricsUploadZone.addEventListener('drop', (event) => {
    event.preventDefault();
    lyricsUploadZone.classList.remove('dragover');

    const [file] = event.dataTransfer.files;
    handleSelectedFile(file);
});

lyricsFileInput.addEventListener('change', (event) => {
    const [file] = event.target.files;
    handleSelectedFile(file);
    event.target.value = '';
});

buttons.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) {
        return;
    }

    const audio = getAudioElement();
    const action = trigger.dataset.action;

    if (action === 'play') {
        audio.play();
    }

    if (action === 'pause') {
        audio.pause();
    }

    if (action === 'lyrics') {
        renderLyricVideo(trigger);
    }
});

lyricsContainer.addEventListener('click', (event) => {
    const line = event.target.closest('p[data-start]');
    if (!line) {
        return;
    }

    const audio = getAudioElement();
    const start = Number(line.dataset.start || 0);
    audio.currentTime = start;
    audio.play();
});

songTitle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        songTitle.blur();
    }
});

songArtist.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        songArtist.blur();
    }
});

songTitle.addEventListener('blur', syncManualTextState);
songArtist.addEventListener('blur', syncManualTextState);

songTitle.classList.add('hidden');
songArtist.classList.add('hidden');
buttons.classList.add('hidden');