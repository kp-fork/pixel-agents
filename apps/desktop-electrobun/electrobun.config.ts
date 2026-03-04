import type { ElectrobunConfig } from 'electrobun';

const config: ElectrobunConfig = {
	app: {
		name: 'Pixel Agents Desktop',
		identifier: 'dev.pixelagents.desktop',
		version: '0.0.0',
		description: 'Standalone desktop host prototype for Pixel Agents',
	},
	build: {
		bun: {
			entrypoint: 'src/bun/index.ts',
		},
	},
	runtime: {
		exitOnLastWindowClosed: true,
	},
};

export default config;
