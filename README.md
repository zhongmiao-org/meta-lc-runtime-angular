# meta-lc-runtime-angular

English | [中文](./README_zh.md)

## Positioning
Angular runtime integration layer for schema rendering/data binding through BFF-only data paths.

## Milestone Mapping
- Primary milestone: Phase 4
- Program board: [GitHub Project #5](https://github.com/orgs/zhongmiao-org/projects/5)

## Scope & Boundaries
- In-scope: module responsibilities mapped to the Meta-Driven SaaS OS mainline.
- Dependency relation: Consumes core contracts and bff data contracts.
- Non-goal: No direct backend/database calls.

## MUST Constraints
- DSL is the single source of truth.
- All data/realtime flows must pass through BFF.
- Runtime must not embed business-rule implementation.
- Meta Kernel is the only structural source.

## Collaboration Notes
- Phase 5 (Designer) and materials stay in   [ngx-lowcode](https://github.com/zhongmiao-org/ngx-lowcode).
- [ngx-puzzle](https://github.com/zhongmiao-org/ngx-puzzle) remains an independent base library.

## Quick Start

after cloning this repo:
```bash
npm ci
npm run build
npm run test -- --watch=false
```

after adding implementation packages:
```ts
import { provideHttpClient } from '@angular/common/http';
import { NGX_LOWCODE_DATASOURCE_MANAGER, NGX_LOWCODE_WEBSOCKET_MANAGER } from '@zhongmiao/ngx-lowcode-core-types';
import { createBffDataSourceManager, createDefaultWebSocketManager } from '@zhongmiao/meta-lc-runtime-angular';

export const appConfig = {
  providers: [
    provideHttpClient(),
    {
      provide: NGX_LOWCODE_DATASOURCE_MANAGER,
      useValue: createBffDataSourceManager({
        baseUrl: 'http://localhost:6000'
      })
    },
    {
      provide: NGX_LOWCODE_WEBSOCKET_MANAGER,
      useValue: createDefaultWebSocketManager()
    }
  ]
};
```


## References
- Unified docs: [lowcode-docs](https://github.com/zhongmiao-org/lowcode-docs)
- Architecture baseline: [Meta-Driven Standard](https://github.com/zhongmiao-org/lowcode-docs/blob/main/meta-driven-standard.md)
