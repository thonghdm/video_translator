// @vitest-environment jsdom
/**
 * Phase 9.5 D4 — test hồi quy cho các lỗi phát hiện khi review.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getVideoDocId } from "../src/content/drive/driveFrame";
import { DriveIndex } from "../src/content/drive/driveIndex";

const FOLDER_A = "https://drive.google.com/drive/folders/folderAAAAAAAAAA";
const FOLDER_B = "https://drive.google.com/drive/folders/folderBBBBBBBBBB";

function row(doc: Document, id: string, name: string): HTMLElement {
  const el = doc.createElement("div");
  el.setAttribute("data-id", id);
  el.setAttribute("aria-label", name);
  doc.body.appendChild(el);
  return el;
}

afterEach(() => vi.useRealTimers());

describe("getVideoDocId (D0-T2: id nằm trong pathname)", () => {
  it("lấy id từ /file/d/{id}/preview", () => {
    expect(getVideoDocId("https://drive.google.com/file/d/vid_ABCDEFGHIJ12/preview")).toBe("vid_ABCDEFGHIJ12");
    expect(getVideoDocId("https://drive.google.com/file/d/vid_ABCDEFGHIJ12/view?usp=sharing")).toBe("vid_ABCDEFGHIJ12");
    expect(getVideoDocId("https://drive.google.com/file/d/vid_ABCDEFGHIJ12")).toBe("vid_ABCDEFGHIJ12");
  });
  it("lấy id từ query docid (player YouTube embed của Drive)", () => {
    expect(getVideoDocId("https://youtube.googleapis.com/embed/?docid=vid_ABCDEFGHIJ12&autoplay=1")).toBe("vid_ABCDEFGHIJ12");
  });
  it("id sai định dạng → null", () => {
    expect(getVideoDocId("https://drive.google.com/file/d/short/preview")).toBeNull();
    expect(getVideoDocId("https://youtube.googleapis.com/embed/?docid=bad%2Fid%2F12345")).toBeNull();
    expect(getVideoDocId("not a url ::")).toBeNull();
  });
});

describe("DriveIndex — các lỗi review", () => {
  it("tắt rồi bật lại (dispose → start) vẫn theo dõi DOM", async () => {
    vi.useFakeTimers();
    const doc = document.implementation.createHTMLDocument("d");
    row(doc, "file_one_1234567890", "One.mp4");
    const index = new DriveIndex(doc, () => FOLDER_A);
    index.start();
    index.dispose();
    index.start();
    expect(index.size).toBe(1);
    row(doc, "file_two_1234567890", "Two.mp4");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(350);
    expect(index.size).toBe(2);
    index.dispose();
  });

  it("DOM đổi liên tục (< 300ms) vẫn scan trong tối đa ~1s", async () => {
    vi.useFakeTimers();
    const doc = document.implementation.createHTMLDocument("d");
    const index = new DriveIndex(doc, () => FOLDER_A);
    index.start();
    row(doc, "file_late_1234567890", "Late.mp4");
    const noise = doc.createElement("span");
    doc.body.appendChild(noise);
    for (let t = 0; t < 1500; t += 100) {
      noise.textContent = String(t);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(index.size).toBe(1);
    index.dispose();
  });

  it("URL tạm thời không có folderId (mở preview) KHÔNG xóa danh sách đã gom; đổi sang thư mục khác thì xóa", () => {
    const doc = document.implementation.createHTMLDocument("d");
    let url = FOLDER_A;
    const r = row(doc, "file_sub_1234567890", "Lesson_en.srt");
    const index = new DriveIndex(doc, () => url);
    index.scan();
    expect(index.size).toBe(1);

    r.remove(); // danh sách ảo hóa: dòng không còn trong DOM
    url = "https://drive.google.com/file/d/vid_ABCDEFGHIJ12/view";
    index.scan();
    expect(index.size).toBe(1);

    url = FOLDER_A;
    index.scan();
    expect(index.size).toBe(1);

    url = FOLDER_B;
    index.scan();
    expect(index.size).toBe(0);
  });

  it("tên lấy từ aria-label, rồi data-tooltip (không dùng nhầm 'aria-label' làm selector)", () => {
    const doc = document.implementation.createHTMLDocument("d");
    const el = doc.createElement("div");
    el.setAttribute("data-id", "file_tip_1234567890");
    el.setAttribute("data-tooltip", "Tip.srt");
    el.innerHTML = "<span>Tip.srt</span><span>me · 2 KB</span>";
    doc.body.appendChild(el);
    const index = new DriveIndex(doc, () => FOLDER_A);
    index.scan();
    // không lấy textContent gộp cả metadata
    const res = (index as unknown as { map: Map<string, string> }).map.get("file_tip_1234567890");
    expect(res).toBe("Tip.srt");
  });

  it("tiêu đề preview: ưu tiên heading trong [role=dialog], không lấy nhầm heading tên thư mục", () => {
    const doc = document.implementation.createHTMLDocument("d");
    const folderHeading = doc.createElement("div");
    folderHeading.setAttribute("role", "heading");
    folderHeading.textContent = "Kubernetes Course";
    doc.body.appendChild(folderHeading);
    row(doc, "file_sub_1234567890", "002 Pods_en.srt");
    const dialog = doc.createElement("div");
    dialog.setAttribute("role", "dialog");
    const title = doc.createElement("div");
    title.setAttribute("role", "heading");
    title.textContent = "002 Pods.mp4";
    dialog.appendChild(title);
    doc.body.appendChild(dialog);
    const after = doc.createElement("div");
    after.setAttribute("role", "heading");
    after.textContent = "Gần đây";
    doc.body.appendChild(after);

    const index = new DriveIndex(doc, () => FOLDER_A);
    index.scan();
    expect(index.lookup()).toMatchObject({ ok: true, result: "match", id: "file_sub_1234567890" });
  });
});
