<script lang="ts">
	import { Settings } from "lucide-svelte";
	import { createEventDispatcher } from "svelte";

	const dispatch = createEventDispatcher();

	function handleSettingsClick(event: KeyboardEvent | MouseEvent) {
		if (
			event instanceof MouseEvent ||
			(event instanceof KeyboardEvent &&
				(event.key === "Enter" || event.key === " "))
		) {
			dispatch("settings");
		}
	}
</script>

<div
	class="clickable-icon extra-setting-button"
	aria-label="Options"
	role="button"
	tabindex="0"
	on:click={handleSettingsClick}
	on:keydown={handleSettingsClick}
>
	<Settings
		class="svg-icon lucide-settings"
		props={{ class: "svg-icon lucide-settings" }}
	/>
</div>

<style>
	.extra-setting-button:focus {
		outline: none;
		box-shadow: none;
		color: var(--icon-color-focus);
	}

	.extra-setting-button:hover {
		box-shadow: none;
		opacity: var(--icon-opacity-hover);
		color: var(--icon-color-hover);
		background-color: var(--background-modifier-hover);
	}
</style>
