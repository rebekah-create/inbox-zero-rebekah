module.exports = {
  reject: [
    // Lint tooling: biome 2.5 / ultracite 7.12 move rules between groups and
    // change preset paths + defaults (15k new errors). Upgrade deliberately.
    "@biomejs/biome",
    "ultracite",

    // >=27.4.0 has ESM/CJS incompatibility that breaks Vercel runtime
    "jsdom",

    // Staying on Tailwind v3 — v4 has significant breaking changes
    "tailwindcss",
    "@tailwindcss/forms",
    "@tailwindcss/typography",
    "@headlessui/tailwindcss",
    "tailwind-merge",
    "tailwindcss-animate",
    "postcss",
    "autoprefixer",

    // Major upgrades have heavy breaking changes
    "@tiptap/extension-mention",
    "@tiptap/extension-placeholder",
    "@tiptap/pm",
    "@tiptap/react",
    "@tiptap/starter-kit",
    "@tiptap/suggestion",
    "tiptap-markdown",
    "react-resizable-panels",
    "recharts",
    "@chronark/zod-bird",

    // v9+ breaks the shadcn/ui date picker component
    "react-day-picker",

    // Stay on Zod 4.x (v5 untested with Tinybird/AI SDK); bump patch/minor by hand
    "zod",

    // v5 imports zod/v4/core; keep this pinned while the app stays on Zod 3
    "@hookform/resolvers",

    // 0.71.6+ pulls in jsonpath, which calls fs.readFileSync(require.resolve(...))
    // at module eval and breaks Turbopack production builds with EBADF.
    // See https://github.com/dubinc/dub-ts/issues/301
    "dub",

    "@types/node",

    // 7.7.0 fails with "Failed to resolve the configuration from ultracite/core"
    // Revisit once upstream ships a fix.
    "ultracite",
  ],
};
