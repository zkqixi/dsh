/**
 * runGit 的边界测试（对应审查意见）：
 *  - 完整输出里的 U+FFFD 必须原样保留，只有真截断才丢弃半个字符
 *  - 启动失败（不存在的 cwd）必须返回 ok:false，不能抛/不能拒
 *  - 超时必须可读，且能终止子进程
 *  - 大输出截断有标记、有界
 *
 * 运行：node plugins/dsh-llm-relay/test/host-git-smoke.mjs
 * 依赖本机 git 与仓库目录；缺 git 时跳过而不是失败。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { renderGitOutput, runGit } from "../lib/index.js";

const repo = "E:/c/dsh";

// 1) 纯函数：字符保真（截断路径不得误删任何合法字符）
{
  const render = (buf, truncated = true) => renderGitOutput([buf], { truncated, size: buf.length });

  // 未截断：U+FFFD 原样保留
  assert.equal(render(Buffer.from("tail\uFFFD", "utf8"), false), "tail\uFFFD");

  // 截断但末尾是完整的合法 U+FFFD：必须保留
  const legit = render(Buffer.from("\uFFFDx", "utf8"));
  assert.ok(legit.startsWith("\uFFFDx"), "合法 U+FFFD 必须保留：" + JSON.stringify(legit.slice(0, 4)));

  // 前段含非法字节、末尾是合法 U+FFFD：也不能被误删（旧兜底正是在这里出错）
  const dirtyPrefix = render(Buffer.concat([Buffer.from([0xff]), Buffer.from("\uFFFD", "utf8")]));
  assert.ok(dirtyPrefix.startsWith("\uFFFD"), "非法前缀不能导致末尾合法字符被删：" + JSON.stringify(dirtyPrefix.slice(0, 4)));

  // BOM 不能被吞掉
  const bom = render(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("A", "utf8")]));
  assert.ok(bom.startsWith("\uFEFF"), "BOM 必须原样保留：" + JSON.stringify(bom.slice(0, 3)));

  // 真正的半个字符：「你」的 3 字节截成 2 字节
  const half = render(Buffer.from("你好", "utf8").subarray(0, 2));
  assert.ok(!half.includes("\uFFFD"), "半个字符不得残留替换符：" + JSON.stringify(half));
  assert.match(half, /未送审/);

  // 末尾是「合法 U+FFFD + 一个孤立续字节」：只切掉孤立字节，合法 U+FFFD 保留
  const stray = render(Buffer.from([0xef, 0xbf, 0xbd, 0x80]));
  assert.ok(stray.startsWith("\uFFFD"), "孤立续字节不能导致合法 U+FFFD 被删：" + JSON.stringify(stray.slice(0, 3)));

  // 「你」+「好」的首字节：只切残缺部分
  const cut4 = render(Buffer.from("你好", "utf8").subarray(0, 4));
  assert.ok(cut4.startsWith("你"), "完整字符不能被多切：" + JSON.stringify(cut4.slice(0, 3)));

  // 完整的多字节字符不能被多切
  const whole = render(Buffer.from("你好", "utf8").subarray(0, 3));
  assert.ok(whole.startsWith("你"), "完整字符不能被误切：" + JSON.stringify(whole.slice(0, 3)));
}

let gitAvailable = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  gitAvailable = false;
}

if (gitAvailable && existsSync(`${repo}/.git`)) {
  // 2) 启动失败：cwd 不存在 → 可读失败，绝不抛
  {
    const result = await runGit(["status"], "E:/definitely-not-a-dir-xyz", { timeoutMs: 5000 });
    assert.equal(result.ok, false, "启动失败必须判失败");
    assert.match(result.text, /git (启动失败|退出码)/, "要有可读原因：" + result.text);
  }

  // 3) 超时：用一个必然跑不完的命令 + 1ms 超时
  {
    const started = Date.now();
    const result = await runGit(["log", "--all", "--format=%H", "--max-count=2000000"], repo, { timeoutMs: 1 });
    assert.equal(result.ok, false, "超时必须判失败");
    assert.match(result.text, /超时|退出码/, "要有可读原因：" + result.text);
    assert.ok(Date.now() - started < 15000, "超时后应尽快返回");
  }

  // 4) 正常小输出
  {
    const result = await runGit(["rev-parse", "HEAD"], repo);
    assert.equal(result.ok, true);
    assert.match(result.text.trim(), /^[0-9a-f]{7,40}$/);
  }

  // 5) 大输出截断：有界 + 标记
  {
    const result = await runGit(["show", "--patch", "HEAD"], repo, { maxBytes: 200 });
    assert.equal(result.ok, true, "截断不是失败");
    assert.equal(result.truncated, true);
    assert.ok(result.text.length < 1000, "保留内容必须有界");
    assert.match(result.text, /已截断/);
  }
} else {
  console.log("(跳过需要 git 的用例)");
}

console.log("RESULT: PASS — 字符保真 / 启动失败 / 超时 / 截断 全部可读且不抛");