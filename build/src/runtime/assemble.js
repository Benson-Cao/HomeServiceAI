import { createKernel } from '../kernel/runtime.js';
import { createMemoryScene } from '../scenes/memory-scene.js';
export function assemble(profile, _options = {}) {
    const kernel = createKernel();
    const created = [];
    for (const b of profile.providers) {
        kernel.plugin({
            id: b.id,
            apply: (ctx) => {
                const provider = b.factory();
                created.push(provider);
                ctx.registerSeam(b.seam, provider);
            },
        });
    }
    // V0.7：全部 L2 seam 已由 profile 装配真实 provider，V0.5 桩整体退役。
    let service = null;
    kernel.plugin(createMemoryScene((s) => { service = s; }));
    return {
        kernel,
        get service() { return service; },
        profileName: profile.name,
        dispose() {
            kernel.dispose();
            for (const p of created) {
                const maybe = p;
                if (maybe && typeof maybe.dispose === 'function')
                    maybe.dispose();
            }
        },
    };
}
