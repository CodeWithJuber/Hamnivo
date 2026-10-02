import type { AgentConfig } from '@hamnivo/contracts';
import { fromPublicId, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, desc, eq, inArray } from 'drizzle-orm';

export interface PublishProblem {
  path: string;
  message: string;
}

/**
 * The tool grants of a draft (G07, G08): every granted tool exists in the agent's own brand and
 * is not waiting for review. A disabled tool may stay granted; it is simply not offered.
 */
export async function toolGrantProblems(
  tx: TenantTx,
  brandId: string,
  config: AgentConfig,
): Promise<PublishProblem[]> {
  if (config.tools.grants.length === 0) return [];
  const ids = config.tools.grants.map((grant) => fromPublicId('tool', grant.toolId));
  const rows = await tx
    .select({
      id: schema.toolDefinitions.id,
      brandId: schema.toolDefinitions.brandId,
      status: schema.toolDefinitions.status,
    })
    .from(schema.toolDefinitions)
    .where(inArray(schema.toolDefinitions.id, ids));
  const problems: PublishProblem[] = [];
  config.tools.grants.forEach((grant, index) => {
    const row = rows.find((r) => r.id === fromPublicId('tool', grant.toolId));
    const path = `config.tools.grants.${index}.toolId`;
    if (!row || row.brandId !== brandId) {
      problems.push({ path, message: 'Unknown tool, or a tool of another brand.' });
    } else if (row.status === 'review') {
      problems.push({
        path,
        message: 'This tool is waiting for review. Review it under Tools before granting it.',
      });
    }
  });
  return problems;
}

/**
 * Required simulation suites (G11, HNV-11-05): publishing a draft waits until its exact
 * configuration passed every suite marked required. The latest run on this draft decides.
 */
export async function simulationProblems(
  tx: TenantTx,
  profileId: string,
  versionId: string,
  hash: Buffer,
): Promise<PublishProblem[]> {
  const required = await tx
    .select()
    .from(schema.simulationSuites)
    .where(
      and(
        eq(schema.simulationSuites.agentId, profileId),
        eq(schema.simulationSuites.required, true),
      ),
    );
  const problems: PublishProblem[] = [];
  for (const suite of required) {
    const [latest] = await tx
      .select()
      .from(schema.simulationRuns)
      .where(
        and(
          eq(schema.simulationRuns.suiteId, suite.id),
          eq(schema.simulationRuns.candidateVersionId, versionId),
        ),
      )
      .orderBy(desc(schema.simulationRuns.startedAt))
      .limit(1);
    const path = `simulations.${toPublicId('simulation', suite.id)}`;
    if (!latest?.candidateConfigHash.equals(hash)) {
      problems.push({
        path,
        message: `Run the required simulation “${suite.name}” on this draft before publishing.`,
      });
    } else if (latest.status !== 'passed') {
      problems.push({
        path,
        message: `The draft fails the required simulation “${suite.name}”. Fix the draft and run it again.`,
      });
    }
  }
  return problems;
}
