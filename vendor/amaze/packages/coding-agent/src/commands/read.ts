/**
 * Show what the read tool will return for a given path.
 */
import { APP_NAME } from "@amaze/utils";
import { Args, Command } from "@amaze/utils/cli";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "../modes/theme/theme";

export default class Read extends Command {
	static description = "Show what the read tool will return for a path or URL";

	static args = {
		path: Args.string({
			description: "Path or URL to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static examples = [
		`${APP_NAME} read src/foo.ts`,
		`${APP_NAME} read src/foo.ts:50-100`,
		`${APP_NAME} read src/foo.ts:raw`,
		`${APP_NAME} read https://example.com`,
		`${APP_NAME} read path/to/archive.zip:dir/file.ts`,
		`${APP_NAME} read path/to/db.sqlite:users:42`,
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
