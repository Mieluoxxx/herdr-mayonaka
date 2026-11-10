# Regenerates mods/mayonaka-files/material/ and material.js: python3 tools/material-icons.py <unpacked material-icon-theme package> mods/mayonaka-files
import json, os, shutil, sys
pkg, out = sys.argv[1], sys.argv[2]
m = json.load(open(f"{pkg}/dist/material-icons.json"))
ICONS = set("""
file folder folder-open
typescript typescript-def javascript react react_ts json yaml toml xml markdown mdx document pdf image svg font audio video zip
python python-misc rust go swift c cpp h hpp java kotlin ruby php lua zig dart scala haskell elixir erlang clojure csharp fsharp objective-c nim nix ocaml r julia perl
html css sass less postcss tailwindcss vue svelte astro angular graphql database prisma proto
console powershell docker git github-actions-workflow editorconfig settings lock key certificate log diff table todo
nodejs npm pnpm yarn bun deno vite webpack rollup esbuild babel eslint prettier biome jest vitest storybook turborepo nx
tsconfig jsconfig readme license changelog contributing authors makefile cmake gradle maven
terraform kubernetes helm nginx vercel netlify firebase supabase
vim jupyter tex latex webassembly shader godot unity tune test-ts test-js test-jsx
""".split())
FOLDERS = set("""
src source lib libs test tests __tests__ spec docs doc node_modules .git .github .vscode dist build out public assets images img icons
scripts script config configs components hooks utils util helpers types styles css api server client app pages routes views layouts
models services store tools bin vendor examples example fonts i18n locales migrations database db prisma packages mods plugins themes
target .cargo docker kubernetes k8s ci .circleci .husky temp tmp logs coverage android ios macos windows linux src-tauri
""".split())
missing = [i for i in ICONS if i not in m["iconDefinitions"]]
ICONS -= set(missing)
names = {k: v for k, v in m["fileNames"].items() if v in ICONS}
exts = {k: v for k, v in m["fileExtensions"].items() if v in ICONS}
folders = {}
for k, v in m["folderNames"].items():
    if k in FOLDERS and v in m["iconDefinitions"]:
        folders[k] = v
        ICONS.add(v); ICONS.add(m["folderNamesExpanded"][k])
os.makedirs(f"{out}/material", exist_ok=True)
for i in sorted(ICONS):
    shutil.copy(f"{pkg}/icons/{m['iconDefinitions'][i]['iconPath'].split('/')[-1]}", f"{out}/material/{i}.svg")
shutil.copy(f"{pkg}/LICENSE", f"{out}/material/LICENSE")
ver = json.load(open(f"{pkg}/package.json"))["version"]
d = lambda x: json.dumps(x, separators=(",", ":"), sort_keys=True)
open(f"{out}/material.js", "w").write(f"""// Generated from material-icon-theme {ver} (MIT, see material/LICENSE) by tools/material-icons.py: a subset of its icons and the lookups that point at them.
// A folder's open icon is always its closed name + "-open".
const NAMES = {d(names)};
const EXTS = {d(exts)};
const FOLDERS = {d(folders)};

// VS Code's order: an exact file name, then the longest dotted suffix ("d.ts" before "ts").
export function fileIcon(name) {{
  const lower = name.toLowerCase();
  if (NAMES[lower]) return NAMES[lower];
  for (let i = lower.indexOf("."); i !== -1; i = lower.indexOf(".", i + 1)) if (EXTS[lower.slice(i + 1)]) return EXTS[lower.slice(i + 1)];
  return "file";
}}
export const folderIcon = (name, open) => (FOLDERS[name.toLowerCase()] ?? "folder") + (open ? "-open" : "");
export const iconPath = (icon) => `mods/mayonaka-files/material/${{icon}}.svg`;
""")
print("missing", missing); print(len(ICONS), "icons", len(names), "names", len(exts), "exts", len(folders), "folders")
