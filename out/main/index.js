"use strict";
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const node_url = require("node:url");
const electron = require("electron");
const node_child_process = require("node:child_process");
const crypto = require("node:crypto");
const node_string_decoder = require("node:string_decoder");
const esbuild = require("esbuild");
const ts = require("typescript");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const esbuild__namespace = /* @__PURE__ */ _interopNamespaceDefault(esbuild);
const IPC = {
  bootstrapGet: "bootstrap:get",
  workspaceChoose: "workspace:choose",
  workspaceOpen: "workspace:open",
  fileOpen: "file:open",
  fileSave: "file:save",
  runStart: "run:start",
  runStop: "run:stop",
  runOutput: "run:output",
  runExit: "run:exit",
  packagesList: "packages:list",
  packagesTypes: "packages:types",
  packagesInstall: "packages:install",
  packagesSync: "packages:sync",
  packagesUninstall: "packages:uninstall",
  packagesStop: "packages:stop",
  packagesOutput: "packages:output",
  appCommand: "app:command"
};
const WORKSPACE_MANIFEST = "package.json";
const SETTINGS_FILE = "settings.json";
function parseJson(text, fallback) {
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}
function sortRecord(record = {}) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}
async function pathIsDirectory(targetPath) {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}
async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}
`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, content, "utf8");
  try {
    await fs.rename(tempPath, filePath);
  } catch {
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
  }
}
function isValidPackageName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 214) return false;
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);
}
function isErrno(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
class WorkspaceService {
  constructor(app) {
    this.app = app;
    this.settingsPath = path.join(app.getPath("userData"), SETTINGS_FILE);
  }
  app;
  settingsPath;
  workspacePath = "";
  async init() {
    const settings = await this.readSettings();
    const configuredPath = typeof settings.workspacePath === "string" && settings.workspacePath.trim() ? settings.workspacePath : null;
    if (configuredPath) {
      try {
        await this.setWorkspace(configuredPath, { persist: false });
        return this.workspacePath;
      } catch {
      }
    }
    const preferred = path.join(this.app.getPath("documents"), "OfflineJsLabWorkspace");
    try {
      await this.setWorkspace(preferred, { persist: true });
    } catch {
      const fallback = path.join(this.app.getPath("userData"), "workspace");
      await this.setWorkspace(fallback, { persist: true });
    }
    return this.workspacePath;
  }
  getPath() {
    if (!this.workspacePath) throw new Error("工作区尚未初始化。");
    return this.workspacePath;
  }
  getManifestPath() {
    return path.join(this.getPath(), WORKSPACE_MANIFEST);
  }
  getNodeModulesPath() {
    return path.join(this.getPath(), "node_modules");
  }
  getRunsPath() {
    return path.join(this.getPath(), ".offline-js-lab", "runs");
  }
  async setWorkspace(inputPath, options = {}) {
    const persist = options.persist ?? true;
    if (typeof inputPath !== "string" || !inputPath.trim()) {
      throw new Error("工作区路径不能为空。");
    }
    const nextPath = path.resolve(inputPath.trim());
    try {
      const stat = await fs.stat(nextPath);
      if (!stat.isDirectory()) throw new Error("所选路径不是文件夹。");
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      await fs.mkdir(nextPath, { recursive: true });
    }
    this.workspacePath = nextPath;
    await this.ensureWorkspaceFiles();
    if (persist) {
      const settings = await this.readSettings();
      await this.writeSettings({ ...settings, workspacePath: nextPath });
    }
    return nextPath;
  }
  async readManifest() {
    try {
      const parsed = parseJson(await fs.readFile(this.getManifestPath(), "utf8"), null);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("工作区 package.json 不是有效的 JSON 对象。");
      }
      const manifest = parsed;
      return {
        ...manifest,
        dependencies: manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies : {},
        devDependencies: manifest.devDependencies && typeof manifest.devDependencies === "object" ? manifest.devDependencies : {}
      };
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        await this.ensureWorkspaceFiles();
        return this.readManifest();
      }
      throw error;
    }
  }
  async writeManifest(manifest) {
    const normalized = {
      ...manifest,
      dependencies: sortRecord(manifest.dependencies ?? {}),
      devDependencies: sortRecord(manifest.devDependencies ?? {})
    };
    await writeJsonAtomic(this.getManifestPath(), normalized);
  }
  packageDirectory(packageName) {
    if (!isValidPackageName(packageName)) {
      throw new Error(`无效的 npm 包名：${packageName}`);
    }
    return path.join(this.getNodeModulesPath(), ...packageName.split("/"));
  }
  async listPackages() {
    const manifest = await this.readManifest();
    const dependencies = manifest.dependencies ?? {};
    const devDependencies = manifest.devDependencies ?? {};
    const packageNames = [.../* @__PURE__ */ new Set([...Object.keys(dependencies), ...Object.keys(devDependencies)])].sort((left, right) => left.localeCompare(right));
    const result = [];
    for (const name of packageNames) {
      let packageJson = null;
      const packageJsonPath = path.join(this.packageDirectory(name), "package.json");
      try {
        packageJson = parseJson(await fs.readFile(packageJsonPath, "utf8"), null);
      } catch {
        packageJson = null;
      }
      result.push({
        name,
        declaredVersion: dependencies[name] ?? devDependencies[name] ?? "",
        installedVersion: packageJson && typeof packageJson.version === "string" ? packageJson.version : null,
        license: packageJson && typeof packageJson.license === "string" ? packageJson.license : null,
        dev: Object.prototype.hasOwnProperty.call(devDependencies, name),
        installed: Boolean(packageJson)
      });
    }
    return result;
  }
  async discoverInstalledPackageDirectories() {
    const nodeModulesPath = this.getNodeModulesPath();
    if (!await pathIsDirectory(nodeModulesPath)) return [];
    const result = [];
    const entries = await fs.readdir(nodeModulesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const firstLevelPath = path.join(nodeModulesPath, entry.name);
      if (entry.name.startsWith("@")) {
        const scopedEntries = await fs.readdir(firstLevelPath, { withFileTypes: true });
        for (const scopedEntry of scopedEntries) {
          if (scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink() && !scopedEntry.name.startsWith(".")) {
            result.push({
              name: `${entry.name}/${scopedEntry.name}`,
              directory: path.join(firstLevelPath, scopedEntry.name)
            });
          }
        }
      } else {
        result.push({ name: entry.name, directory: firstLevelPath });
      }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }
  async collectTypeDefinitions(limits = {}) {
    const maxFiles = limits.maxFiles ?? 800;
    const maxBytes = limits.maxBytes ?? 8 * 1024 * 1024;
    const packages = await this.discoverInstalledPackageDirectories();
    const files = [];
    const state = { bytes: 0, truncated: false };
    for (const packageInfo of packages) {
      if (state.truncated) break;
      await this.scanTypeFiles(packageInfo.directory, files, state, { maxFiles, maxBytes });
    }
    return { files, truncated: state.truncated, totalBytes: state.bytes };
  }
  async scanTypeFiles(directory, files, state, limits) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (state.truncated) return;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await this.scanTypeFiles(fullPath, files, state, limits);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
      const stat = await fs.stat(fullPath);
      if (files.length >= limits.maxFiles || state.bytes + stat.size > limits.maxBytes) {
        state.truncated = true;
        return;
      }
      const content = await fs.readFile(fullPath, "utf8");
      const relativePath = path.relative(this.getNodeModulesPath(), fullPath).split(path.sep).join("/");
      files.push({ uri: `file:///workspace/node_modules/${relativePath}`, content });
      state.bytes += Buffer.byteLength(content, "utf8");
    }
  }
  async ensureWorkspaceFiles() {
    await fs.mkdir(this.getNodeModulesPath(), { recursive: true });
    await fs.mkdir(this.getRunsPath(), { recursive: true });
    try {
      await fs.access(this.getManifestPath());
    } catch {
      await writeJsonAtomic(this.getManifestPath(), {
        name: "offline-js-lab-workspace",
        version: "1.0.0",
        private: true,
        description: "Packages used by Offline JS Lab scripts.",
        dependencies: {},
        devDependencies: {}
      });
    }
  }
  async readSettings() {
    try {
      return parseJson(await fs.readFile(this.settingsPath, "utf8"), {});
    } catch {
      return {};
    }
  }
  async writeSettings(settings) {
    await writeJsonAtomic(this.settingsPath, settings);
  }
}
function existingPath(value) {
  return typeof value === "string" && value.length > 0 && fsSync.existsSync(value) ? value : null;
}
function resolveNodeRuntime(env = process.env, platform = process.platform) {
  const npmNode = existingPath(env.npm_node_execpath);
  if (npmNode) {
    return { command: npmNode, argsPrefix: [], source: "npm_node_execpath" };
  }
  const explicitNode = existingPath(env.OFFLINE_JS_LAB_NODE);
  if (explicitNode) {
    return { command: explicitNode, argsPrefix: [], source: "OFFLINE_JS_LAB_NODE" };
  }
  return {
    command: platform === "win32" ? "node.exe" : "node",
    argsPrefix: [],
    source: "PATH"
  };
}
function resolveNpmRuntime(env = process.env, platform = process.platform) {
  const npmCli = existingPath(env.npm_execpath);
  if (npmCli) {
    const nodeRuntime = resolveNodeRuntime(env, platform);
    return {
      command: nodeRuntime.command,
      argsPrefix: [...nodeRuntime.argsPrefix, npmCli],
      source: `npm CLI via ${nodeRuntime.source}`
    };
  }
  const explicitNpm = existingPath(env.OFFLINE_JS_LAB_NPM);
  if (explicitNpm) {
    return { command: explicitNpm, argsPrefix: [], source: "OFFLINE_JS_LAB_NPM" };
  }
  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    argsPrefix: [],
    source: "PATH"
  };
}
function createChildEnvironment(extra = {}, options = {}) {
  const environment = {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extra
  };
  if (!options.preserveNodeOptions) delete environment.NODE_OPTIONS;
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}
function describeRuntime(runtime) {
  const prefix = runtime.argsPrefix.length > 0 ? ` ${runtime.argsPrefix.join(" ")}` : "";
  return `${runtime.command}${prefix}`;
}
const MAX_PACKAGE_SPECS = 50;
function packageNameFromSpec(spec) {
  if (spec.startsWith("@")) {
    const slashIndex = spec.indexOf("/");
    if (slashIndex < 2) return spec;
    const versionIndex2 = spec.indexOf("@", slashIndex + 1);
    return versionIndex2 === -1 ? spec : spec.slice(0, versionIndex2);
  }
  const versionIndex = spec.lastIndexOf("@");
  return versionIndex > 0 ? spec.slice(0, versionIndex) : spec;
}
function parsePackageSpecs(input) {
  const values = Array.isArray(input) ? input : String(input ?? "").split(/[\s,]+/);
  const specs = values.map((value) => String(value).trim()).filter(Boolean);
  if (specs.length === 0) throw new Error("请输入至少一个 npm 包名，例如 lodash dayjs。");
  if (specs.length > MAX_PACKAGE_SPECS) {
    throw new Error(`一次最多安装 ${MAX_PACKAGE_SPECS} 个包。`);
  }
  for (const spec of specs) {
    if (spec.length > 300 || spec.startsWith("-") || /[\u0000-\u001f\u007f\s]/.test(spec)) {
      throw new Error(`不支持的 npm 包参数：${spec}`);
    }
    if (!isValidPackageName(packageNameFromSpec(spec))) {
      throw new Error(`无效的 npm 包名：${spec}`);
    }
  }
  return [...new Set(specs)];
}
function parsePackageNames(input) {
  const values = Array.isArray(input) ? input : String(input ?? "").split(/[\s,]+/);
  const names = values.map((value) => String(value).trim()).filter(Boolean);
  if (names.length === 0) throw new Error("缺少要卸载的 npm 包名。");
  for (const name of names) {
    if (!isValidPackageName(name)) throw new Error(`无效的 npm 包名：${name}`);
  }
  return [...new Set(names)];
}
function buildNpmArguments(action, payload = {}) {
  const common = ["--no-audit", "--no-fund", "--color=false"];
  if (action === "install") {
    return [
      "install",
      ...parsePackageSpecs(payload.specs),
      payload.dev ? "--save-dev" : "--save",
      ...common
    ];
  }
  if (action === "sync") return ["install", ...common];
  if (action === "uninstall") return ["uninstall", ...parsePackageNames(payload.names), ...common];
  throw new Error(`不支持的 npm 操作：${String(action)}`);
}
function emitOutput(callback, stream, text) {
  if (callback && text) callback({ stream, text: String(text) });
}
class NpmManager {
  constructor(workspace2, spawnProcess = node_child_process.spawn, resolveRuntime = resolveNpmRuntime) {
    this.workspace = workspace2;
    this.spawnProcess = spawnProcess;
    this.resolveRuntime = resolveRuntime;
  }
  workspace;
  spawnProcess;
  resolveRuntime;
  active = null;
  getRuntimeInfo() {
    const runtime = this.resolveRuntime();
    return { command: describeRuntime(runtime), source: runtime.source };
  }
  async run(action, payload = {}, onOutput) {
    if (this.active) throw new Error("已有 npm 操作正在执行。");
    const npmArguments = buildNpmArguments(action, payload);
    const runtime = this.resolveRuntime();
    const args = [...runtime.argsPrefix, ...npmArguments];
    const cwd = this.workspace.getPath();
    emitOutput(onOutput, "system", `$ npm ${npmArguments.join(" ")}
`);
    return new Promise((resolve, reject) => {
      let child = null;
      let settled = false;
      const clearActive = () => {
        if (child && this.active?.child === child) this.active = null;
      };
      try {
        child = this.spawnProcess(runtime.command, args, {
          cwd,
          env: createChildEnvironment(
            { OFFLINE_JS_LAB: "1" },
            { preserveNodeOptions: true }
          ),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
      } catch (error) {
        reject(new Error(`无法启动 npm：${toErrorMessage$1(error)}`));
        return;
      }
      this.active = { child, action };
      child.stdout?.on("data", (chunk) => emitOutput(onOutput, "stdout", chunk.toString("utf8")));
      child.stderr?.on("data", (chunk) => emitOutput(onOutput, "stderr", chunk.toString("utf8")));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearActive();
        reject(
          new Error(
            `npm 启动失败：${error.message}。请确认 Node.js/npm 已安装，或通过 npm start 启动应用。`
          )
        );
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearActive();
        const normalizedCode = Number.isInteger(code) ? code : null;
        resolve({
          ok: normalizedCode === 0,
          code: normalizedCode,
          signal: signal ?? null,
          action
        });
      });
    });
  }
  stop() {
    return this.active ? this.active.child.kill() : false;
  }
  stopAll() {
    this.stop();
  }
}
function toErrorMessage$1(error) {
  return error instanceof Error ? error.message : String(error);
}
const LINE_AWARE_CONSOLE_METHODS = /* @__PURE__ */ new Set(["debug", "error", "info", "log", "warn"]);
function sourceLineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
function getConsoleMethod(node) {
  const callee = node.expression;
  if (node.questionDotToken) return null;
  if (ts.isPropertyAccessExpression(callee) && !callee.questionDotToken && ts.isIdentifier(callee.expression) && callee.expression.text === "console" && LINE_AWARE_CONSOLE_METHODS.has(callee.name.text)) {
    return callee.name.text;
  }
  if (ts.isElementAccessExpression(callee) && !callee.questionDotToken && ts.isIdentifier(callee.expression) && callee.expression.text === "console" && callee.argumentExpression && ts.isStringLiteral(callee.argumentExpression) && LINE_AWARE_CONSOLE_METHODS.has(callee.argumentExpression.text)) {
    return callee.argumentExpression.text;
  }
  return null;
}
function unwrapTransparentExpression(expression) {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}
function isDirectConsoleCall(node) {
  const callee = unwrapTransparentExpression(node.expression);
  return (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && ts.isIdentifier(callee.expression) && callee.expression.text === "console";
}
function isDirectivePrologue(statement) {
  if (!ts.isStringLiteral(statement.expression)) return false;
  const parent = statement.parent;
  let statements;
  if (ts.isSourceFile(parent)) {
    statements = parent.statements;
  } else if (ts.isBlock(parent) && ts.isFunctionLike(parent.parent)) {
    statements = parent.statements;
  }
  if (!statements) return false;
  for (const current of statements) {
    if (current === statement) return true;
    if (!ts.isExpressionStatement(current) || !ts.isStringLiteral(current.expression)) return false;
  }
  return false;
}
function isImplicitOutputCandidate(expression) {
  let excluded = false;
  const visit = (node) => {
    if (excluded) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isDeleteExpression(node) || ts.isVoidExpression(node) || ts.isPostfixUnaryExpression(node) || ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      excluded = true;
      return;
    }
    if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      excluded = true;
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      excluded = true;
      return;
    }
    if (ts.isFunctionLike(node) || ts.isClassExpression(node)) {
      if (node === expression) excluded = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return !excluded;
}
function getImplicitOutputKind(expression) {
  const unwrapped = unwrapTransparentExpression(expression);
  const possibleCall = ts.isAwaitExpression(unwrapped) ? unwrapTransparentExpression(unwrapped.expression) : unwrapped;
  if (ts.isCallExpression(possibleCall)) {
    return isDirectConsoleCall(possibleCall) ? null : "call";
  }
  return isImplicitOutputCandidate(expression) ? "value" : null;
}
function applyEdits(code, edits) {
  const ordered = [...edits].sort(
    (left, right) => right.start - left.start || right.end - left.end
  );
  let instrumented = code;
  for (const edit of ordered) {
    instrumented = instrumented.slice(0, edit.start) + edit.text + instrumented.slice(edit.end);
  }
  return instrumented;
}
function instrumentSource(code, language) {
  const sourceFile = ts.createSourceFile(
    language === "typescript" ? "scratch.ts" : "scratch.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    language === "typescript" ? ts.ScriptKind.TS : ts.ScriptKind.JS
  );
  const edits = [];
  const consoleLines = /* @__PURE__ */ new Set();
  const implicitLines = /* @__PURE__ */ new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const method = getConsoleMethod(node);
      if (method) {
        const line = sourceLineOf(sourceFile, node);
        const originalCallee = node.expression.getText(sourceFile);
        consoleLines.add(line);
        edits.push(
          {
            start: node.expression.getStart(sourceFile),
            end: node.expression.end,
            text: "globalThis.__offlineJsLabConsole"
          },
          {
            start: node.arguments.pos,
            end: node.arguments.pos,
            text: `${line}, ${JSON.stringify(method)}, ${originalCallee}, console` + (node.arguments.length ? ", " : "")
          }
        );
      }
    }
    if (ts.isExpressionStatement(node) && !isDirectivePrologue(node)) {
      const outputKind = getImplicitOutputKind(node.expression);
      if (outputKind) {
        const line = sourceLineOf(sourceFile, node.expression);
        implicitLines.add(line);
        edits.push(
          {
            start: node.expression.getStart(sourceFile),
            end: node.expression.getStart(sourceFile),
            text: outputKind === "call" ? `globalThis.__offlineJsLabInspectCall(${line}, (` : `globalThis.__offlineJsLabInspect(${line}, (`
          },
          { start: node.expression.end, end: node.expression.end, text: "))" }
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    code: applyEdits(code, edits),
    consoleLines: [...consoleLines].sort((left, right) => left - right),
    implicitLines: [...implicitLines].sort((left, right) => left - right)
  };
}
const MAX_CODE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_STRUCTURED_FRAME_BYTES = 512 * 1024;
const ESM_COMPATIBILITY_BANNER = `
import { createRequire as __offlineCreateRequire } from 'node:module';
import { fileURLToPath as __offlineFileURLToPath } from 'node:url';
import { dirname as __offlineDirname } from 'node:path';
const require = __offlineCreateRequire(import.meta.url);
const __filename = __offlineFileURLToPath(import.meta.url);
const __dirname = __offlineDirname(__filename);
`;
function formatBuildError(error) {
  const buildError = error;
  if (!Array.isArray(buildError?.errors) || buildError.errors.length === 0) {
    return error instanceof Error ? error.message : String(error);
  }
  return buildError.errors.map((item) => {
    if (!item.location) return item.text;
    const file = item.location.file || "scratch";
    return `${file}:${item.location.line}:${item.location.column + 1} ${item.text}`;
  }).join("\n");
}
async function removeQuietly(filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
  }
}
function send$1(webContents, channel, payload) {
  if (!webContents.isDestroyed()) webContents.send(channel, payload);
}
class RunManager {
  constructor(workspace2, getRunnerPath2, spawnProcess = node_child_process.spawn, resolveRuntime = resolveNodeRuntime, getCompiler = () => esbuild__namespace) {
    this.workspace = workspace2;
    this.getRunnerPath = getRunnerPath2;
    this.spawnProcess = spawnProcess;
    this.resolveRuntime = resolveRuntime;
    this.getCompiler = getCompiler;
  }
  workspace;
  getRunnerPath;
  spawnProcess;
  resolveRuntime;
  getCompiler;
  runs = /* @__PURE__ */ new Map();
  getRuntimeInfo() {
    const runtime = this.resolveRuntime();
    return { command: describeRuntime(runtime), source: runtime.source };
  }
  async start(webContents, payload) {
    const code = typeof payload?.code === "string" ? payload.code : "";
    const language = payload?.language === "javascript" ? "javascript" : "typescript";
    const sourceFilePath = payload?.sourceFilePath ? path.resolve(payload.sourceFilePath) : null;
    if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
      return {
        ok: false,
        error: `脚本超过 ${MAX_CODE_BYTES / 1024 / 1024} MB 的 MVP 限制。`
      };
    }
    const runId = crypto.randomUUID();
    const outputPath = path.join(this.workspace.getRunsPath(), `${runId}.mjs`);
    const resolveDir = sourceFilePath ? path.dirname(sourceFilePath) : this.workspace.getPath();
    const sourceFile = sourceFilePath ? path.basename(sourceFilePath) : language === "typescript" ? "scratch.ts" : "scratch.js";
    await fs.mkdir(this.workspace.getRunsPath(), { recursive: true });
    try {
      const compiler = this.getCompiler();
      const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "22", 10);
      await compiler.build({
        stdin: {
          contents: instrumentSource(code, language).code,
          loader: language === "typescript" ? "ts" : "js",
          resolveDir,
          sourcefile: sourceFile
        },
        absWorkingDir: this.workspace.getPath(),
        banner: { js: ESM_COMPATIBILITY_BANNER },
        bundle: true,
        charset: "utf8",
        format: "esm",
        legalComments: "none",
        logLevel: "silent",
        nodePaths: [this.workspace.getNodeModulesPath()],
        outfile: outputPath,
        platform: "node",
        sourcemap: "inline",
        target: [`node${Number.isFinite(nodeMajor) ? nodeMajor : 22}`]
      });
    } catch (error) {
      await removeQuietly(outputPath);
      return { ok: false, error: formatBuildError(error) };
    }
    const runtime = this.resolveRuntime();
    const args = [...runtime.argsPrefix, this.getRunnerPath(), outputPath];
    let child;
    try {
      child = this.spawnProcess(runtime.command, args, {
        cwd: this.workspace.getPath(),
        env: createChildEnvironment({ OFFLINE_JS_LAB: "1" }),
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      await removeQuietly(outputPath);
      return { ok: false, error: `无法启动 Node.js 执行进程：${toErrorMessage(error)}` };
    }
    const record = {
      child,
      outputPath,
      reason: "completed",
      startedAt: Date.now(),
      outputBytes: 0,
      outputLimited: false
    };
    this.runs.set(runId, record);
    const terminateForOutputLimit = (message) => {
      const currentRecord = this.runs.get(runId);
      if (!currentRecord || currentRecord.outputLimited) return;
      currentRecord.outputLimited = true;
      currentRecord.reason = "output-limit";
      send$1(webContents, IPC.runOutput, {
        runId,
        stream: "system",
        text: message ?? `
输出超过 ${MAX_OUTPUT_BYTES / 1024 / 1024} MB，已终止执行进程。
`
      });
      currentRecord.child.kill();
    };
    const forwardOutput = (stream, chunk, sourceLine) => {
      const currentRecord = this.runs.get(runId);
      if (!currentRecord || currentRecord.outputLimited) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - currentRecord.outputBytes);
      const accepted = buffer.subarray(0, remaining);
      if (accepted.length > 0) {
        const payload2 = {
          runId,
          stream,
          text: accepted.toString("utf8")
        };
        if (sourceLine && Number.isInteger(sourceLine)) payload2.sourceLine = sourceLine;
        send$1(webContents, IPC.runOutput, payload2);
      }
      currentRecord.outputBytes += buffer.length;
      if (buffer.length > remaining) {
        terminateForOutputLimit();
      }
    };
    child.stdout?.on("data", (chunk) => forwardOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => forwardOutput("stderr", chunk));
    const structuredOutput = child.stdio[3];
    if (structuredOutput && "on" in structuredOutput) {
      const decoder = new node_string_decoder.StringDecoder("utf8");
      let pending = "";
      const consumeRecords = (flush = false) => {
        const records = pending.split("\n");
        pending = flush ? "" : records.pop() ?? "";
        for (const record2 of records) {
          if (!record2) continue;
          try {
            const parsed = JSON.parse(record2);
            if (!Number.isInteger(parsed.line) || Number(parsed.line) < 1 || parsed.stream !== "stdout" && parsed.stream !== "stderr" && parsed.stream !== "expression" || typeof parsed.text !== "string") {
              throw new Error("invalid record");
            }
            forwardOutput(parsed.stream, parsed.text, Number(parsed.line));
          } catch {
            forwardOutput("stderr", "[内部输出协议错误：已忽略一条无法解析的行定位记录。]\n");
          }
        }
      };
      structuredOutput.on("data", (chunk) => {
        pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        if (Buffer.byteLength(pending, "utf8") > MAX_STRUCTURED_FRAME_BYTES) {
          pending = "";
          terminateForOutputLimit("\n行定位输出记录异常过大，已终止执行进程。\n");
          return;
        }
        consumeRecords();
      });
      structuredOutput.on("end", () => {
        pending += decoder.end();
        if (pending) pending += "\n";
        consumeRecords(true);
      });
    }
    child.once("error", (error) => {
      const currentRecord = this.runs.get(runId);
      if (currentRecord) currentRecord.reason = "failed";
      send$1(webContents, IPC.runOutput, {
        runId,
        stream: "stderr",
        text: `无法启动 Node.js：${error.message}
请确认 Node.js 位于 PATH 中，或使用 npm start 启动应用。
`
      });
    });
    child.once("close", async (code2, signal) => {
      const latestRecord = this.runs.get(runId) ?? record;
      this.runs.delete(runId);
      await removeQuietly(outputPath);
      if (latestRecord.reason === "completed" && Number.isInteger(code2) && code2 !== 0) {
        latestRecord.reason = "failed";
      }
      const exitPayload = {
        runId,
        code: Number.isInteger(code2) ? code2 : null,
        signal: signal ?? null,
        reason: latestRecord.reason,
        durationMs: Date.now() - latestRecord.startedAt
      };
      send$1(webContents, IPC.runExit, exitPayload);
    });
    return { ok: true, runId, runtime: describeRuntime(runtime) };
  }
  stop(runId) {
    const record = this.runs.get(runId);
    if (!record) return false;
    record.reason = "stopped";
    return record.child.kill();
  }
  stopAll() {
    for (const record of this.runs.values()) {
      record.reason = "app-closed";
      record.child.kill();
    }
  }
}
function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
const MAX_FILE_BYTES = 10 * 1024 * 1024;
electron.app.setName("Offline JS Lab");
let mainWindow = null;
let workspaceService = null;
let npmManager = null;
let runManager = null;
function workspace() {
  if (!workspaceService) throw new Error("工作区服务尚未初始化。");
  return workspaceService;
}
function npmService() {
  if (!npmManager) throw new Error("npm 服务尚未初始化。");
  return npmManager;
}
function runner() {
  if (!runManager) throw new Error("运行服务尚未初始化。");
  return runManager;
}
function resolveUnpackedPath(inputPath) {
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!inputPath.includes(marker)) return inputPath;
  const unpackedPath = inputPath.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`);
  return fsSync.existsSync(unpackedPath) ? unpackedPath : inputPath;
}
function configureEsbuildBinary() {
  if (!electron.app.isPackaged) return;
  const platformPackage = `${process.platform}-${process.arch}`;
  const binaryRelativePath = process.platform === "win32" ? "esbuild.exe" : path.join("bin", "esbuild");
  const candidate = path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@esbuild",
    platformPackage,
    binaryRelativePath
  );
  if (fsSync.existsSync(candidate)) process.env.ESBUILD_BINARY_PATH = candidate;
}
function getRunnerPath() {
  if (electron.app.isPackaged) return resolveUnpackedPath(path.join(process.resourcesPath, "runner.cjs"));
  return path.join(process.cwd(), "src", "main", "runner.cjs");
}
function getBuiltRendererUrl() {
  return node_url.pathToFileURL(path.join(__dirname, "../renderer/index.html")).href;
}
function isTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    try {
      return new URL(senderUrl).origin === new URL(devUrl).origin;
    } catch {
      return false;
    }
  }
  return senderUrl === getBuiltRendererUrl();
}
function registerTrustedHandler(channel, handler) {
  electron.ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error("拒绝来自非应用页面的 IPC 请求。");
    return handler(event, ...args);
  });
}
function getOwnerWindow(webContents) {
  return electron.BrowserWindow.fromWebContents(webContents) || mainWindow;
}
function showOpenDialog(webContents, options) {
  const owner = getOwnerWindow(webContents);
  return owner ? electron.dialog.showOpenDialog(owner, options) : electron.dialog.showOpenDialog(options);
}
function showSaveDialog(webContents, options) {
  const owner = getOwnerWindow(webContents);
  return owner ? electron.dialog.showSaveDialog(owner, options) : electron.dialog.showSaveDialog(options);
}
function send(webContents, channel, payload) {
  if (webContents && !webContents.isDestroyed()) webContents.send(channel, payload);
}
function sendAppCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    send(mainWindow.webContents, IPC.appCommand, command);
  }
}
function guessLanguage(filePath) {
  return /\.(?:ts|mts|cts)$/i.test(filePath) ? "typescript" : "javascript";
}
async function getPackageState() {
  return {
    workspacePath: workspace().getPath(),
    installed: await workspace().listPackages(),
    npmRuntime: npmService().getRuntimeInfo()
  };
}
async function getBootstrapState() {
  return {
    appVersion: electron.app.getVersion(),
    platform: process.platform,
    isPackaged: electron.app.isPackaged,
    packages: await getPackageState(),
    nodeRuntime: runner().getRuntimeInfo()
  };
}
async function runNpmOperation(event, action, payload = {}) {
  const progress = (output) => {
    send(event.sender, IPC.packagesOutput, output);
  };
  const result = await npmService().run(action, payload, progress);
  return { ...result, packages: await getPackageState() };
}
function registerIpcHandlers() {
  registerTrustedHandler(IPC.bootstrapGet, () => getBootstrapState());
  registerTrustedHandler(IPC.workspaceChoose, async (event) => {
    const result = await showOpenDialog(event.sender, {
      title: "选择 Offline JS Lab 工作区",
      defaultPath: workspace().getPath(),
      properties: ["openDirectory", "createDirectory", "promptToCreate"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    runner().stopAll();
    npmService().stopAll();
    const selectedPath = result.filePaths[0];
    if (!selectedPath) return null;
    await workspace().setWorkspace(selectedPath);
    return getPackageState();
  });
  registerTrustedHandler(IPC.workspaceOpen, async () => {
    const errorMessage = await electron.shell.openPath(workspace().getPath());
    return errorMessage || null;
  });
  registerTrustedHandler(IPC.fileOpen, async (event) => {
    const result = await showOpenDialog(event.sender, {
      title: "打开 JS/TS 脚本",
      defaultPath: workspace().getPath(),
      properties: ["openFile"],
      filters: [
        { name: "JavaScript / TypeScript", extensions: ["js", "mjs", "cjs", "ts", "mts", "cts"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    if (!filePath) return null;
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 的 MVP 限制。`);
    }
    return {
      filePath,
      content: await fs.readFile(filePath, "utf8"),
      language: guessLanguage(filePath)
    };
  });
  registerTrustedHandler(IPC.fileSave, async (event, rawPayload) => {
    const payload = rawPayload ?? {};
    const content = typeof payload.content === "string" ? payload.content : "";
    const language = payload.language === "javascript" ? "javascript" : "typescript";
    const forceSaveAs = Boolean(payload.saveAs);
    let filePath = typeof payload.filePath === "string" && payload.filePath ? path.resolve(payload.filePath) : null;
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 的 MVP 限制。`);
    }
    if (!filePath || forceSaveAs) {
      const defaultName = language === "typescript" ? "scratch.ts" : "scratch.js";
      const result = await showSaveDialog(event.sender, {
        title: "保存脚本",
        defaultPath: filePath || path.join(workspace().getPath(), defaultName),
        filters: [
          {
            name: language === "typescript" ? "TypeScript" : "JavaScript",
            extensions: language === "typescript" ? ["ts"] : ["js"]
          },
          { name: "所有文件", extensions: ["*"] }
        ]
      });
      if (result.canceled || !result.filePath) return null;
      filePath = result.filePath;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
    return { filePath, language: guessLanguage(filePath) };
  });
  registerTrustedHandler(
    IPC.runStart,
    (event, payload) => runner().start(event.sender, payload)
  );
  registerTrustedHandler(
    IPC.runStop,
    (_event, runId) => runner().stop(typeof runId === "string" ? runId : "")
  );
  registerTrustedHandler(IPC.packagesList, () => getPackageState());
  registerTrustedHandler(IPC.packagesTypes, () => workspace().collectTypeDefinitions());
  registerTrustedHandler(
    IPC.packagesInstall,
    (event, payload) => runNpmOperation(event, "install", payload)
  );
  registerTrustedHandler(IPC.packagesSync, (event) => runNpmOperation(event, "sync"));
  registerTrustedHandler(
    IPC.packagesUninstall,
    (event, payload) => runNpmOperation(event, "uninstall", payload)
  );
  registerTrustedHandler(IPC.packagesStop, () => npmService().stop());
}
function createApplicationMenu() {
  if (process.platform !== "darwin") {
    electron.Menu.setApplicationMenu(null);
    return;
  }
  const template = [
    {
      label: electron.app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "文件",
      submenu: [
        { label: "新建", accelerator: "CmdOrCtrl+N", click: () => sendAppCommand("new") },
        { label: "打开…", accelerator: "CmdOrCtrl+O", click: () => sendAppCommand("open") },
        { type: "separator" },
        { label: "保存", accelerator: "CmdOrCtrl+S", click: () => sendAppCommand("save") },
        {
          label: "另存为…",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => sendAppCommand("save-as")
        },
        { type: "separator" },
        { role: "close" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "运行",
      submenu: [
        {
          label: "运行代码",
          accelerator: "CmdOrCtrl+Enter",
          click: () => sendAppCommand("run")
        },
        {
          label: "停止运行",
          accelerator: "CmdOrCtrl+.",
          click: () => sendAppCommand("stop")
        }
      ]
    },
    {
      label: "显示",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" }
      ]
    }
  ];
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
function createWindow() {
  const window = new electron.BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: "Offline JS Lab",
    backgroundColor: "#05070a",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    runManager?.stopAll();
    npmManager?.stopAll();
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
electron.app.whenReady().then(async () => {
  configureEsbuildBinary();
  workspaceService = new WorkspaceService(electron.app);
  await workspaceService.init();
  npmManager = new NpmManager(workspaceService);
  runManager = new RunManager(workspaceService, getRunnerPath);
  registerIpcHandlers();
  createApplicationMenu();
  electron.session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("before-quit", () => {
  runManager?.stopAll();
  npmManager?.stopAll();
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
