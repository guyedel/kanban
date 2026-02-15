import type { ReactElement } from "react";
import "@/app-layout.css";
import {
	ActionList,
	Button,
	CounterLabel,
	FormControl,
	Heading,
	PageHeader,
	PageLayout,
	Stack,
	TextInput,
} from "@primer/react";
import { PlayIcon, PlusIcon, ProjectIcon, TasklistIcon } from "@primer/octicons-react";

const BOARD_COLUMNS = [
	{
		id: "todo",
		title: "Todo",
		count: 4,
		tasks: ["Wire ACP transport", "Define task schema", "Set up task polling"],
	},
	{
		id: "in-progress",
		title: "In Progress",
		count: 2,
		tasks: ["Agent status stream", "Task creation flow"],
	},
	{
		id: "done",
		title: "Done",
		count: 1,
		tasks: ["Primer foundation"],
	},
] as const;

export default function App(): ReactElement {
	return (
		<main>
			<PageLayout containerWidth="xlarge" padding="normal" rowGap="normal">
				<PageLayout.Header divider="line" aria-label="Mission control header">
					<PageHeader>
						<PageHeader.TitleArea variant="large">
							<PageHeader.LeadingVisual>
								<ProjectIcon aria-hidden="true" />
							</PageHeader.LeadingVisual>
							<PageHeader.Title as="h1">Kanbanana Mission Control</PageHeader.Title>
							<PageHeader.Actions>
								<Button variant="primary" leadingVisual={PlusIcon}>
									New Task
								</Button>
							</PageHeader.Actions>
						</PageHeader.TitleArea>
						<PageHeader.Description>
							Kanban orchestration for ACP-powered CLI agents.
						</PageHeader.Description>
					</PageHeader>
				</PageLayout.Header>

				<PageLayout.Content aria-label="Mission control board">
					<Stack direction="vertical" gap="spacious">
						<FormControl>
							<FormControl.Label>Quick capture</FormControl.Label>
							<TextInput
								block
								leadingVisual={PlayIcon}
								placeholder="Describe the next task for an agent..."
							/>
							<FormControl.Caption>
								Write a task, then route it to Todo for execution.
							</FormControl.Caption>
						</FormControl>

						<Stack as="section" aria-label="Kanban board" direction="horizontal" gap="normal" wrap="wrap">
								{BOARD_COLUMNS.map((column) => (
									<Stack
										as="article"
										key={column.id}
										direction="vertical"
										gap="condensed"
										className="kanbanColumn"
									>
									<Stack direction="horizontal" justify="space-between" align="center">
										<Heading as="h2" variant="small">
											{column.title}
										</Heading>
										<CounterLabel>{column.count}</CounterLabel>
									</Stack>
									<ActionList>
										{column.tasks.map((task) => (
											<ActionList.Item key={task}>
												<ActionList.LeadingVisual>
													<TasklistIcon aria-hidden="true" />
												</ActionList.LeadingVisual>
												{task}
											</ActionList.Item>
										))}
									</ActionList>
								</Stack>
							))}
						</Stack>
					</Stack>
				</PageLayout.Content>
			</PageLayout>
		</main>
	);
}
