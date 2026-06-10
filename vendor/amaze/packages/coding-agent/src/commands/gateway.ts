import { APP_NAME } from "@amaze/utils";
import { Args, Command, Flags, renderCommandHelp } from "@amaze/utils/cli";
import { type GatewayCliAction, runGatewayCommand } from "../cli/gateway-cli";

const ACTIONS: GatewayCliAction[] = ["check", "start", "send"];

export default class Gateway extends Command {
	static description = "Run and inspect Amaze chat platform gateways";

	static args = {
		action: Args.string({ description: "Gateway action", required: false, options: ACTIONS }),
	};

	static flags = {
		config: Flags.string({ description: "Path to gateway JSON config" }),
		platform: Flags.string({ description: "Platform for send: telegram or discord" }),
		chat: Flags.string({ description: "Destination chat/channel id for send" }),
		text: Flags.string({ description: "Message text for send" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Gateway);
		if (!args.action) {
			renderCommandHelp(APP_NAME, "gateway", Gateway);
			return;
		}
		await runGatewayCommand({
			action: args.action as GatewayCliAction,
			config: flags.config,
			platform: flags.platform,
			chat: flags.chat,
			text: flags.text,
			json: flags.json,
		});
	}
}
