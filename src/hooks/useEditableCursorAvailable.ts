import { useEffect, useState } from "react";
import { offersEditableCursor } from "@/lib/editableCursorAvailability";
import { getPlatform } from "@/utils/platformUtils";

/**
 * Whether the editable cursor is worth offering here (see `offersEditableCursor`).
 *
 * `false` until the answer arrives, so the row waits for the native helper's answer and a failed
 * one keeps it hidden: showing a control that does nothing is the worse mistake.
 */
export function useEditableCursorAvailable(): boolean {
	const [available, setAvailable] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void offersEditableCursor(getPlatform(), window.electronAPI).then((offered) => {
			if (!cancelled) setAvailable(offered);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	return available;
}
