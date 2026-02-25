# View Harness (Scaffold)

Minimal standalone harness that exercises the pipeline:

1. mock host bridge emits inbound messages
2. core store consumes transitions
3. view-model mapper produces render-safe output
4. harness renderer prints the result

## Scripts

- `npm run start`: run the demo event stream with `tsx`
- `npm run check-types`: type-check harness + referenced core/view-model sources
- `npm run build`: compile harness TypeScript to `dist/`
