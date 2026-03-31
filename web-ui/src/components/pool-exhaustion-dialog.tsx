import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { saveRuntimeConfig } from "@/runtime/runtime-config-query";

export function PoolExhaustionDialog({
	open,
	onOpenChange,
	currentMaxSlots,
	workspaceId,
	onRetry,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	currentMaxSlots: number;
	workspaceId: string | null;
	onRetry: () => void;
}): React.ReactElement {
	const [isIncreasing, setIsIncreasing] = useState(false);

	const handleIncrease = useCallback(async () => {
		setIsIncreasing(true);
		try {
			await saveRuntimeConfig(workspaceId, {
				worktreePool: { maxSlots: currentMaxSlots + 1 },
			});
			onOpenChange(false);
			onRetry();
		} catch {
			// Save failed — dialog stays open for user to retry or cancel
		} finally {
			setIsIncreasing(false);
		}
	}, [currentMaxSlots, workspaceId, onOpenChange, onRetry]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogHeader title="Worktree pool full" />
			<DialogBody>
				<p className="text-[13px] text-text-primary m-0">
					All {currentMaxSlots} worktree slots are currently in use.
				</p>
				<p className="text-[13px] text-text-secondary mt-2 mb-0">
					Free a slot by completing or trashing a task, or increase the pool capacity.
				</p>
			</DialogBody>
			<DialogFooter>
				<Button variant="default" size="sm" onClick={() => onOpenChange(false)} disabled={isIncreasing}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" onClick={handleIncrease} disabled={isIncreasing}>
					{isIncreasing ? <Spinner size={14} /> : `Increase to ${currentMaxSlots + 1}`}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
