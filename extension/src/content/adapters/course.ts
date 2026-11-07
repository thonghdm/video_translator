/**
 * SubTrans Extension — Adapter cho các trang khóa học trực tuyến (Udemy, Coursera, edX...)
 * Phù hợp với Mục 7 (Phase 9) của PLAN.md
 * Mỗi adapter phải tự cô lập: lỗi ở đây không bao giờ được làm hỏng adapter html5 cơ sở.
 */

import type { SiteAdapter, SubtitleSource } from "./types";
import { Html5TrackSource, pickTrackIndex, type FetchTextFn, type TextTrackLike } from "./html5";

/** Các domain nền tảng học tập phổ biến */
const COURSE_DOMAINS = [
  "udemy.com",
  "coursera.org",
  "edx.org",
  "skillshare.com",
  "pluralsight.com",
  "linkedin.com", // LinkedIn Learning
];

export function isCourseHost(hostname: string): boolean {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return COURSE_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Selector tìm khung bọc player trên các nền tảng khóa học để overlay bám sát */
const PLAYER_CONTAINER_SELECTORS = [
  // Udemy (VideoJS)
  '[data-purpose="video-player"]',
  ".video-player--container",
  ".vjs-v6",
  ".video-js",
  // Coursera
  ".rc-VideoPlayer",
  ".video-player-container",
  '[data-testid="video-player"]',
  // edX
  ".video-wrapper",
  ".tc-wrapper",
];

export function findCoursePlayerContainer(video: HTMLVideoElement): HTMLElement | null {
  for (const sel of PLAYER_CONTAINER_SELECTORS) {
    const el = video.closest<HTMLElement>(sel);
    if (el) return el;
  }

  // Nếu không khớp selector cụ thể, kiểm tra xem thẻ cha có position !== static không
  const parent = video.parentElement;
  if (parent && typeof window !== "undefined") {
    try {
      const pos = window.getComputedStyle(parent).position;
      if (pos === "relative" || pos === "absolute") {
        return parent;
      }
    } catch {
      // Bỏ qua lỗi trong môi trường không có style
    }
  }

  return null;
}

export function createCourseAdapter(fetchText?: FetchTextFn): SiteAdapter {
  return {
    name: "course",
    matches: (loc: Location) => isCourseHost(loc.hostname),

    getOverlayContainer: (video: HTMLVideoElement) => {
      try {
        return findCoursePlayerContainer(video);
      } catch (err) {
        if (import.meta.env?.DEV) console.warn("[SubTrans][course] getOverlayContainer lỗi:", err);
        return null;
      }
    },

    listSources: async (video: HTMLVideoElement): Promise<SubtitleSource[]> => {
      try {
        const tracks = video.textTracks;
        if (!tracks || tracks.length === 0) {
          return [];
        }

        const idx = pickTrackIndex(tracks as unknown as ArrayLike<TextTrackLike>);
        if (idx < 0) {
          return [];
        }

        return [new Html5TrackSource(video, tracks[idx], idx, { fetchText })];
      } catch (err) {
        // Tự cô lập lỗi: không để lỗi trong adapter khóa học làm sập luồng chính
        if (import.meta.env?.DEV) console.warn("[SubTrans][course] listSources lỗi:", err);
        return [];
      }
    },
  };
}
