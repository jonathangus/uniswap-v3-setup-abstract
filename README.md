# pool-abstract-init

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

## Command-Line Arguments

The script can be executed with the following command-line arguments:

- **`--create`**: Triggers the creation of new tokens and a liquidity pool if they do not already exist. When this flag is present, the script will deploy two tokens and create a pool for them, saving the details in a cache file for future reference.
