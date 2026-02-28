const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const CHAR_COUNT = 6;

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Copy runtime assets to dist/assets.
 * Source 1: webview-ui/public/assets (walls, floors, characters, default-layout)
 * Source 2: assets/furniture (custom furniture catalog + PNGs)
 */
function buildBundledDefaultPack(dstDir, webviewAssetsDir, furnitureAssetsDir) {
	const layoutSrc = path.join(webviewAssetsDir, 'default-layout.json');
	const charsDirSrc = path.join(webviewAssetsDir, 'characters');
	const catalogSrc = path.join(furnitureAssetsDir, 'furniture-catalog.json');
	const customDirSrc = path.join(furnitureAssetsDir, 'custom');
	if (!fs.existsSync(layoutSrc) || !fs.existsSync(catalogSrc)) {
		console.log('ℹ️  Skipping bundled default pack (missing default-layout or furniture catalog)');
		return;
	}

	const packRoot = path.join(dstDir, 'packs', 'default');
	if (fs.existsSync(packRoot)) {
		fs.rmSync(packRoot, { recursive: true, force: true });
	}

	fs.mkdirSync(path.join(packRoot, 'layouts'), { recursive: true });
	fs.mkdirSync(path.join(packRoot, 'assets', 'furniture', 'custom'), { recursive: true });

	fs.copyFileSync(layoutSrc, path.join(packRoot, 'layouts', 'default-layout.json'));
	fs.copyFileSync(catalogSrc, path.join(packRoot, 'assets', 'furniture', 'furniture-catalog.json'));
	if (fs.existsSync(customDirSrc)) {
		fs.cpSync(customDirSrc, path.join(packRoot, 'assets', 'furniture', 'custom'), { recursive: true });
	}
	let hasChars = false;
	if (fs.existsSync(charsDirSrc)) {
		let present = 0;
		for (let i = 0; i < CHAR_COUNT; i++) {
			if (fs.existsSync(path.join(charsDirSrc, `char_${i}.png`))) {
				present++;
			}
		}
		if (present === CHAR_COUNT) {
			hasChars = true;
		} else if (present > 0) {
			console.log(`ℹ️  Skipping character sprites in default pack (incomplete set ${present}/${CHAR_COUNT})`);
		}
	}
	if (hasChars) {
		fs.cpSync(charsDirSrc, path.join(packRoot, 'assets', 'characters'), { recursive: true });
	}

	const manifest = {
		packVersion: 1,
		id: 'pixel-agents.default-layout.v1',
		name: 'Pixel Agents Default Pack',
		description: 'Bundled default pack generated at build time',
		author: 'pixel-agents',
		createdAt: new Date().toISOString(),
		entryLayout: 'layouts/default-layout.json',
		furnitureCatalog: 'assets/furniture/furniture-catalog.json',
		characterSpritesDir: hasChars ? 'assets/characters' : undefined,
	};
	fs.writeFileSync(path.join(packRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
	console.log('✓ Built bundled default pack → dist/assets/packs/default/');
}

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

	// 3) Build bundled default pack for first-run bootstrapping
	buildBundledDefaultPack(dstDir, webviewAssetsDir, furnitureAssetsDir);
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
