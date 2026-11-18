export function mountMinimalTree(kernel) {
    const defs = [
        { id: 'storage.primary', apply: (ctx) => ctx.registerSeam('storage', { kind: 'in-memory' }) },
        { id: 'embedder.primary', apply: (ctx) => ctx.registerSeam('embedder', { dim: 8 }) },
        { id: 'llm.primary', apply: (ctx) => ctx.registerSeam('llm', { mode: 'dual-channel' }) },
        { id: 'queue.primary', apply: (ctx) => ctx.registerSeam('queue', { bounded: true }) },
        { id: 'policy.primary', apply: (ctx) => ctx.registerSeam('isolation-policy', {
                evaluate: ({ principal, bank, operation }) => Boolean(principal && bank && operation === 'recall'),
            }) },
        { id: 'retriever.semantic', inject: ['storage', 'embedder'], apply: (ctx) => ctx.registerSeam('retriever.semantic', { owner: ctx.pluginId }) },
        { id: 'agent.entry', inject: ['llm', 'storage', 'retriever.semantic', 'queue'], apply: (ctx) => ctx.on('memory.retain.accepted', () => { }) },
        { id: 'reflect.worker', inject: ['consolidator'], apply: () => { } },
    ];
    const unloads = defs.map((d) => kernel.plugin(d));
    return () => { for (const u of unloads.reverse())
        u(); };
}
