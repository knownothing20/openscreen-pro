import type { ReactNode } from "react";

import styles from "./styles.module.css";

/** Two loops side by side on a wide column. Each picks its own file from its
 *  own width, so a half-column loop gets the 720p encode. */
export default function DemoLoopPair({ children }: { children: ReactNode }) {
	return <div className={styles.pair}>{children}</div>;
}
