/**
 * Unit tests cho Phase 9: Google Drive Embed và Course Platforms (Udemy, Coursera, edX)
 */

import { describe, it, expect } from "vitest";
import { isYouTubeHost, isYouTubeWatch } from "../src/content/adapters/youtube";
import { extractVideoId } from "../src/content/adapters/ytParser";
import {
  isCourseHost,
  findCoursePlayerContainer,
  createCourseAdapter,
} from "../src/content/adapters/course";

describe("Phase 9: Google Drive & YouTube Embed Detection", () => {
  it("isYouTubeHost: nhận diện cả youtube.googleapis.com và youtube-nocookie", () => {
    expect(isYouTubeHost("www.youtube.com")).toBe(true);
    expect(isYouTubeHost("youtube.com")).toBe(true);
    expect(isYouTubeHost("m.youtube.com")).toBe(true);
    expect(isYouTubeHost("youtube.googleapis.com")).toBe(true);
    expect(isYouTubeHost("www.youtube-nocookie.com")).toBe(true);

    expect(isYouTubeHost("drive.google.com")).toBe(false);
    expect(isYouTubeHost("udemy.com")).toBe(false);
    expect(isYouTubeHost("")).toBe(false);
  });

  it("extractVideoId: trích xuất đúng videoId từ URL thường, embed, và youtu.be", () => {
    // 1. YouTube watch thông thường
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");

    // 2. YouTube Embed (Google Drive iframe player)
    expect(extractVideoId("https://youtube.googleapis.com/embed/gdriveVideo123")).toBe("gdriveVideo123");
    expect(extractVideoId("https://www.youtube.com/embed/embedVideo456?autoplay=1")).toBe("embedVideo456");

    // 3. youtu.be rút gọn
    expect(extractVideoId("https://youtu.be/shortVideo789")).toBe("shortVideo789");

    // 4. URL không có video
    expect(extractVideoId("https://www.youtube.com/feed/subscriptions")).toBe(null);
  });

  it("isYouTubeWatch: chấp nhận cả trang /watch và /embed/", () => {
    expect(
      isYouTubeWatch({
        hostname: "www.youtube.com",
        pathname: "/watch",
        href: "https://www.youtube.com/watch?v=abc123",
      })
    ).toBe(true);

    expect(
      isYouTubeWatch({
        hostname: "youtube.googleapis.com",
        pathname: "/embed/xyz999",
        href: "https://youtube.googleapis.com/embed/xyz999",
      })
    ).toBe(true);

    expect(
      isYouTubeWatch({
        hostname: "www.youtube.com",
        pathname: "/feed/history",
        href: "https://www.youtube.com/feed/history",
      })
    ).toBe(false);
  });
});

describe("Phase 9: Course Platforms Adapter (Udemy, Coursera, edX)", () => {
  it("isCourseHost: nhận diện đúng domain của các nền tảng học trực tuyến", () => {
    expect(isCourseHost("www.udemy.com")).toBe(true);
    expect(isCourseHost("udemy.com")).toBe(true);
    expect(isCourseHost("www.coursera.org")).toBe(true);
    expect(isCourseHost("coursera.org")).toBe(true);
    expect(isCourseHost("learning.edx.org")).toBe(true);
    expect(isCourseHost("edx.org")).toBe(true);
    expect(isCourseHost("www.skillshare.com")).toBe(true);

    expect(isCourseHost("youtube.com")).toBe(false);
    expect(isCourseHost("github.com")).toBe(false);
    expect(isCourseHost("google.com")).toBe(false);
  });

  it("findCoursePlayerContainer: tìm đúng container của Udemy / Coursera", () => {
    const container = document.createElement("div");
    container.setAttribute("data-purpose", "video-player");

    const video = document.createElement("video");
    container.appendChild(video);
    document.body.appendChild(container);

    const found = findCoursePlayerContainer(video);
    expect(found).toBe(container);

    container.remove();
  });

  it("CourseAdapter: tự cô lập lỗi, trả về mảng rỗng khi xảy ra exception", async () => {
    const adapter = createCourseAdapter();

    // Mock video với textTracks ném lỗi khi truy cập
    const faultyVideo = {
      get textTracks(): TextTrackList {
        throw new Error("Lỗi giả lập bảo mật CORS trên textTracks");
      },
    } as unknown as HTMLVideoElement;

    // Không được làm văng lỗi (crash) ra ngoài
    const sources = await adapter.listSources(faultyVideo);
    expect(sources).toEqual([]);
  });
});
