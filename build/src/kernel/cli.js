/**
 * 内核诊断 CLI。只做参数解析与输出格式化；示例装配来自 src/examples，不在内核里写业务。
 */
import { createKernel, CONTRACT_VERSION, EVENT_TYPES } from './runtime.js';
import { mountMinimalTree } from '../examples/minimal-tree.js';
const argv = new Set(process.argv.slice(2));
const has = (f) => argv.has(f);
function usage() {
    console.log(`Memory Harness kernel ${CONTRACT_VERSION}
  --dump-tree            插件树 + PENDING 诊断
  --json                 以 JSON 输出（配合 --dump-tree）
  --strict               存在 PENDING / failed 时 exit 1（供 CI）
  --events               列出已声明的事件类型
  --version              契约版本
  --help                 本帮助`);
}
if (has('--help') || (!has('--dump-tree') && !has('--events') && !has('--version'))) {
    usage();
}
else if (has('--version')) {
    console.log(CONTRACT_VERSION);
}
else if (has('--events')) {
    console.log(EVENT_TYPES.join('\n'));
}
else {
    const kernel = createKernel();
    const teardown = mountMinimalTree(kernel);
    const tree = kernel.dumpTree();
    const pending = tree.filter((f) => f.state !== 'active');
    const services = kernel.services;
    if (has('--json')) {
        console.log(JSON.stringify({ contractVersion: CONTRACT_VERSION, tree, services }, null, 2));
    }
    else {
        console.log(`Memory Harness kernel · contract ${CONTRACT_VERSION}\n`);
        console.log(`插件树（${tree.length}）`);
        const width = Math.max(...tree.map((f) => f.id.length), 12);
        for (const f of tree) {
            const state = f.state.toUpperCase().padEnd(8);
            const deps = f.deps.length ? f.deps.join(', ') : '-';
            console.log(`  ${state} ${f.id.padEnd(width)}  deps: ${deps}${f.error ? `  error: ${f.error}` : ''}`);
        }
        console.log(`\nPENDING 诊断（${pending.length}）`);
        if (!pending.length) {
            console.log('  全部插件已激活，无缺失依赖。');
        }
        else {
            for (const f of pending) {
                console.log(`  ${f.id}  state=${f.state}  缺失依赖: ${f.missingDeps.join(', ') || '-'}`);
            }
            console.log('  提示: 依赖缺失不等于失败，插件停在 PENDING、进程照常；补上 provider 后自动激活。');
        }
        console.log(`\n已注册 seam（${services.length}）: ${services.join(', ') || '-'}`);
    }
    teardown();
    kernel.dispose();
    if (has('--strict') && pending.length)
        process.exit(1);
}
