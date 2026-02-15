import { expect, test } from "@playwright/test";

test("renders mission control shell", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Kanbanana Mission Control" })).toBeVisible();
	await expect(page.getByRole("button", { name: "New Task" })).toBeVisible();
});
