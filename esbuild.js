const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Copy runtime assets to dist/assets.
 * Source 1: webview-ui/public/assets (walls, floors, characters, default-layout)
 * Source 2: assets/furniture (custom furniture catalog + PNGs)
 */
function copyAssets() {
	const dstDir = path.join(__dirname, 'dist', 'assets');
	const webviewAssetsDir = path.join(__dirname, 'webview-ui', 'public', 'assets');
	const furnitureAssetsDir = path.join(__dirname, 'assets', 'furniture');

	// Remove existing dist/assets if present
	if (fs.existsSync(dstDir)) {
		fs.rmSync(dstDir, { recursive: true });
	}

	// 1) Copy webview assets
	if (fs.existsSync(webviewAssetsDir)) {
		fs.cpSync(webviewAssetsDir, dstDir, { recursive: true });
		console.log('✓ Copied webview assets → dist/assets/');
	} else {
		console.log('ℹ️  webview-ui/public/assets not found');
	}

	// 2) Copy furniture assets used by extension runtime loader
	if (fs.existsSync(furnitureAssetsDir)) {
		const furnitureDst = path.join(dstDir, 'furniture');
		fs.cpSync(furnitureAssetsDir, furnitureDst, { recursive: true });
		console.log('✓ Copied furniture assets → dist/assets/furniture/');
	} else {
		console.log('ℹ️  assets/furniture not found');
	}
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
		// Copy assets after build
		copyAssets();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
