import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

/**
 * Đổi rem → px (×16) CHỈ cho CSS của overlay (src/content/overlay/).
 * Lý do: YouTube đặt `html { font-size: 10px }`, nên mọi kích thước Tailwind theo rem bị teo còn 62.5%
 * khi chạy trong Shadow DOM trên trang đó (PLAN 4.9). Popup/options là trang riêng, giữ nguyên rem.
 */
const OVERLAY_DIR_RE = /[\\/]src[\\/]content[\\/]overlay[\\/]/;
const REM_RE = /(-?\d*\.?\d+)rem\b/g;

function remToPxForOverlay() {
  return {
    postcssPlugin: "subtrans-rem-to-px",
    Once(root) {
      const file = root.source?.input?.file ?? "";
      if (!OVERLAY_DIR_RE.test(file)) return;
      root.walkDecls((decl) => {
        if (decl.value.includes("rem")) {
          decl.value = decl.value.replace(REM_RE, (_m, n) => `${parseFloat(n) * 16}px`);
        }
      });
      root.walkAtRules((rule) => {
        if (rule.params.includes("rem")) {
          rule.params = rule.params.replace(REM_RE, (_m, n) => `${parseFloat(n) * 16}px`);
        }
      });
    },
  };
}
remToPxForOverlay.postcss = true;

export default {
  plugins: [tailwindcss(), autoprefixer(), remToPxForOverlay()],
};
