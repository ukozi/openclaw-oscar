import { describe, expect, it } from 'vitest';
import type { FilesPolicy } from '../../../src/config.js';
import { FILES_LIMITS } from '../../../src/inbound/media-gate.js';
import { classify, planSend, routeOf } from '../../../src/sending/plan.js';

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)));
const u16be = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u16le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

const png = (w: number, h: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), 'IHDR', u32be(w), u32be(h), [8, 2, 0, 0, 0]);
const gif = (w: number, h: number) => bytes('GIF89a', u16le(w), u16le(h), [0, 0, 0], [0x2c], u16le(0), u16le(0), u16le(w), u16le(h), [0, 2, 2, 0x4c, 0x01, 0], [0x3b]);
const jpeg = (w: number, h: number) => bytes([0xff, 0xd8, 0xff, 0xe0], u16be(16), 'JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0], [0xff, 0xc0], u16be(11), [8], u16be(h), u16be(w), [1, 1, 0x11, 0], [0xff, 0xd9]);
const bmp = (w: number, h: number) => bytes('BM', u32le(58), [0, 0, 0, 0], u32le(54), u32le(40), u32le(w), u32le(h), u16le(1), u16le(24), new Array(28).fill(0));
const webp = () => bytes('RIFF', u32le(26), 'WEBPVP8 ', u32le(10), [0x9d, 0x01, 0x2a], u16le(4), u16le(3), [0, 0, 0]);
const pdf = () => bytes('%PDF-1.7\n1 0 obj\n<< >>\nendobj\n%%EOF\n');
const text = (s: string) => new TextEncoder().encode(s);

const policy = (over: Partial<FilesPolicy> = {}): FilesPolicy => ({ directIm: true, sendFile: true, maxBytes: 10 * 1024 * 1024, ...over });

describe('classify', () => {
  it('classes a GIF, a JPEG, a PNG and a BMP as pictures with their size', () => {
    const cases: [Uint8Array, string, number, number][] = [
      [gif(32, 16), 'wave.gif', 32, 16],
      [jpeg(640, 480), 'photo.jpg', 640, 480],
      [png(800, 600), 'chart.png', 800, 600],
      [bmp(4, 3), 'old.bmp', 4, 3],
    ];
    for (const [data, name, width, height] of cases) {
      expect(classify(data, name)).toEqual({ kind: 'picture', picture: { name, bytes: data, width, height } });
    }
  });

  it('classes a WebP, a PDF, text and unknown bytes as files', () => {
    const cases: [Uint8Array, string][] = [
      [webp(), 'photo.webp'],
      [pdf(), 'report.pdf'],
      [text('# Notes\n\nNothing to see.\n'), 'notes.md'],
      [text('BMW parts list, all of them, with prices and stock\n'), 'cars.txt'],
      [bytes([0, 1, 2, 3, 0xfe, 0xff]), 'blob.bin'],
      [new Uint8Array(0), 'empty.png'],
    ];
    for (const [data, name] of cases) {
      expect(classify(data, name)).toEqual({ kind: 'file', file: { name, bytes: data } });
    }
  });

  it('classes a picture header with no size as a file', () => {
    for (const [data, name] of [
      [png(0, 600), 'flat.png'],
      [gif(0, 0), 'none.gif'],
      [bytes([0xff, 0xd8, 0xff, 0xe0], u16be(16), 'JFIF'), 'cut.jpg'],
      [bmp(4, 0), 'thin.bmp'],
    ] as [Uint8Array, string][]) {
      expect(classify(data, name).kind).toBe('file');
    }
  });

  it('cleans a name with a folder in it', () => {
    const picture = classify(png(2, 2), '/home/someone/media/outbound/chart.png');
    expect(picture.kind === 'picture' && picture.picture.name).toBe('chart.png');
    const file = classify(pdf(), 'C:\\Users\\someone\\report.pdf');
    expect(file.kind === 'file' && file.file.name).toBe('report.pdf');
    const plain = classify(pdf(), '');
    expect(plain.kind === 'file' && plain.file.name).toBe('file');
  });
});

describe('routeOf', () => {
  it('sends a picture over Direct IM when that is on, and a file over Send File', () => {
    expect(routeOf('picture', policy())).toBe('direct-im');
    expect(routeOf('file', policy())).toBe('send-file');
    expect(routeOf('file', policy({ directIm: true, sendFile: false }))).toBe('off');
  });

  it('sends a picture as a file when only Send File is on', () => {
    expect(routeOf('picture', policy({ directIm: false, sendFile: true }))).toBe('send-file');
  });

  it('routes nothing when both settings are off', () => {
    const off = policy({ directIm: false, sendFile: false });
    expect(routeOf('picture', off)).toBe('off');
    expect(routeOf('file', off)).toBe('off');
  });
});

describe('planSend', () => {
  it('splits pictures and files by their route', () => {
    const plan = planSend([{ bytes: png(2, 2), name: 'a.png' }, { bytes: pdf(), name: 'b.pdf' }], policy());
    expect(plan.pictures.map((p) => p.name)).toEqual(['a.png']);
    expect(plan.files.map((f) => f.name)).toEqual(['b.pdf']);
    expect(plan.left).toBe(0);
  });

  it('sends a picture as a file when only Send File is on', () => {
    const plan = planSend([{ bytes: png(2, 2), name: 'a.png' }], policy({ directIm: false }));
    expect(plan.pictures).toEqual([]);
    expect(plan.files.map((f) => f.name)).toEqual(['a.png']);
  });

  it('routes nothing when both settings are off', () => {
    const plan = planSend([{ bytes: png(2, 2), name: 'a.png' }, { bytes: pdf(), name: 'b.pdf' }], policy({ directIm: false, sendFile: false }));
    expect(plan.pictures).toEqual([]);
    expect(plan.files).toEqual([]);
  });

  it('keeps three and counts the rest', () => {
    const items = ['1.pdf', '2.png', '3.pdf', '4.png', '5.pdf'].map((name) => ({ bytes: name.endsWith('.png') ? png(2, 2) : pdf(), name }));
    const plan = planSend(items, policy());
    expect(FILES_LIMITS.perSend).toBe(3);
    expect([...plan.pictures, ...plan.files].map((x) => x.name).sort()).toEqual(['1.pdf', '2.png', '3.pdf']);
    expect(plan.left).toBe(2);
  });

  it('cleans a name with a folder in it', () => {
    const plan = planSend([{ bytes: pdf(), name: '../../secret/report.pdf' }], policy());
    expect(plan.files[0]?.name).toBe('report.pdf');
  });
});
