import { SetStateAction } from "react";
import { Checkbox, Icon, Popup, Table } from "semantic-ui-react";
import { FixtureRecord } from "sonamu";

type FixtureResultProps = {
  fixtureRecords: FixtureRecord[];
  onRelationToggle: (
    parentFixtureId: string,
    entityId: string,
    id: number,
    isChecked: boolean
  ) => void;
  selectedIds: Set<string>;
  setFixtureRecords: (value: SetStateAction<FixtureRecord[]>) => void;
};

export default function FixtureRecordViewer({
  fixtureRecords,
  onRelationToggle,
  selectedIds,
  setFixtureRecords,
}: FixtureResultProps) {
  const groupedRecords = Object.entries(
    fixtureRecords.reduce((acc, record) => {
      if (!acc[record.entityId]) {
        acc[record.entityId] = [];
      }
      acc[record.entityId].push(record);
      return acc;
    }, {} as Record<string, FixtureRecord[]>)
  );

  const refineColumns = (columns: Record<string, any>) => {
    return Object.entries(columns).filter(([c]) => c !== "id");
  };

  return (
    <div className="fixture-record-viewer">
      {groupedRecords.map(([, records]) => (
        <Table
          celled
          structured
          className="entity-table"
          key={records[0].entityId}
        >
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell
                colSpan={Object.keys(records[0].columns).length + 1}
              >
                {records[0].entityId}
              </Table.HeaderCell>
            </Table.Row>
            <Table.Row>
              <Table.HeaderCell collapsing content="ID" />
              <Table.HeaderCell collapsing content="DB" />
              {refineColumns(records[0].columns).map(([key]) => (
                <Table.HeaderCell key={key} collapsing>
                  {key}
                </Table.HeaderCell>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {records.map((record) => (
              <>
                <Table.Row
                  key={record.id}
                  className={record.unique ? "unique-violated" : ""}
                >
                  <Table.Cell
                    collapsing
                    rowSpan={record.target || record.unique ? 2 : 1}
                  >
                    {record.id} {record.unique && `(${record.unique.id})`}
                    {record.target && (
                      <Popup
                        content="Override"
                        position="top center"
                        trigger={
                          <div
                            style={{
                              cursor: "pointer",
                              padding: "1em",
                              paddingRight: "0",
                              display: "inline",
                            }}
                            onClick={() => {
                              setFixtureRecords((prev) =>
                                prev.map((r) =>
                                  r.id === record.id
                                    ? { ...r, override: !r.override }
                                    : r
                                )
                              );
                            }}
                          >
                            <Icon
                              name="check"
                              color={record.override ? "green" : "grey"}
                            />
                          </div>
                        }
                      />
                    )}
                    {record.unique && (
                      <span onClick={(e) => e.stopPropagation()}>
                        <Popup
                          content="Unique Violated"
                          position="top center"
                          trigger={
                            <div
                              style={{
                                cursor: "pointer",
                                padding: "1em",
                                paddingRight: "0",
                                display: "inline",
                              }}
                            >
                              <Icon name="question circle outline" />
                            </div>
                          }
                        />
                      </span>
                    )}
                  </Table.Cell>

                  <Table.Cell collapsing>source</Table.Cell>
                  {refineColumns(record.columns).map(
                    ([key, { prop, value }]) => (
                      <Table.Cell key={key} collapsing>
                        {(Array.isArray(value) ? value : [value]).map(
                          (v, index) =>
                            prop.type === "relation" &&
                            prop.relationType !== "BelongsToOne" ? (
                              <div key={index}>
                                {JSON.stringify(v)}
                                {v !== null && (
                                  <Checkbox
                                    checked={selectedIds.has(
                                      `${prop.with}#${v}`
                                    )}
                                    onChange={(_, data) => {
                                      onRelationToggle(
                                        record.fixtureId,
                                        prop.with,
                                        v,
                                        data.checked as boolean
                                      );
                                    }}
                                  />
                                )}
                              </div>
                            ) : (
                              JSON.stringify(v)
                            )
                        )}
                      </Table.Cell>
                    )
                  )}
                </Table.Row>

                {record.target && (
                  <Table.Row key={record.target.id} warning>
                    <Table.Cell collapsing>target</Table.Cell>
                    {refineColumns(record.target.columns).map(
                      ([key, { value }]) => (
                        <Table.Cell key={key} collapsing>
                          {JSON.stringify(value)}
                        </Table.Cell>
                      )
                    )}
                  </Table.Row>
                )}

                {record.unique && (
                  <Table.Row key={record.id + "unique"}>
                    <Table.Cell collapsing>target</Table.Cell>
                    {refineColumns(record.unique.columns).map(
                      ([key, { value }]) => (
                        <Table.Cell key={key} collapsing>
                          {JSON.stringify(value)}
                        </Table.Cell>
                      )
                    )}
                  </Table.Row>
                )}
              </>
            ))}
          </Table.Body>
        </Table>
      ))}
    </div>
  );
}
