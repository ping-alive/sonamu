import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("two_factors", (table) => {
    // add
    table.boolean("verified").notNullable().defaultTo(knex.raw("true"));
    table.integer("failed_verification_count").notNullable().defaultTo(knex.raw("0"));
    table.timestamp("locked_until", { useTz: true, precision: 3 }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("two_factors", (table) => {
    // rollback - add
    table.dropColumns("verified", "failed_verification_count", "locked_until");
  });
}
