export const DEFAULT_TYPESCRIPT = `type RecordItem = {
  projectName: string;
  indexValue: number;
};

const records: RecordItem[] = [
  { projectName: 'Alpha', indexValue: 12 },
  { projectName: 'Alpha', indexValue: 2 },
  { projectName: 'Beta', indexValue: 20 },
];

const totals = records.reduce<Record<string, number>>((result, item) => {
  result[item.projectName] = (result[item.projectName] ?? 0) + item.indexValue;
  return result;
}, {});

console.log(totals);

// 在 DEPENDENCY MATRIX 中 npm install lodash dayjs 后可直接使用：
// import _ from 'lodash';
// import dayjs from 'dayjs';
// console.log(_.groupBy(records, 'projectName'));
// console.log(dayjs('20260908').format('YYYY-MM-DD'));
`

export const DEFAULT_JAVASCRIPT = `const records = [
  { projectName: 'Alpha', indexValue: 12 },
  { projectName: 'Alpha', indexValue: 2 },
  { projectName: 'Beta', indexValue: 20 },
];

const totals = records.reduce((result, item) => {
  result[item.projectName] = (result[item.projectName] ?? 0) + item.indexValue;
  return result;
}, {});

console.log(totals);

// 在 DEPENDENCY MATRIX 中 npm install lodash dayjs 后可直接使用：
// const _ = require('lodash');
// const dayjs = require('dayjs');
// console.log(_.groupBy(records, 'projectName'));
// console.log(dayjs('20260908').format('YYYY-MM-DD'));
`
