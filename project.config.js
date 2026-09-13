module.exports = {
  port: 3912,
  title: '钟乳石洞穴微环境巡测',
  lede: '围绕洞穴、分区、样点和巡测路线记录微环境数据，发现异常后自动生成待办，由两人接力复查并销项。',
  // 演示环境的身份名册：真实部署中由登录系统提供
  users: [
    { id: 'u-chen', name: '陈岿', role: 'admin', title: '管理员' },
    { id: 'u-shen', name: '沈宁', role: 'surveyor', title: '巡测员' },
    { id: 'u-luo', name: '骆岑', role: 'surveyor', title: '巡测员' },
    { id: 'u-yan', name: '严叙', role: 'reviewer', title: '复查员' },
    { id: 'u-zhi', name: '郅敏', role: 'reviewer', title: '复查员' }
  ],
  // 各等级处理时限（小时），管理员可在规则页调整
  defaultSlaHours: { '中': 48, '高': 24, review: 24 },
  tones: {
    '常规观察': 'ok',
    '正常': 'ok',
    '已复查': 'ok',
    '已销项': 'ok',
    '重点保护': 'warn',
    '异常待复查': 'bad',
    '暂停开放': 'bad',
    '待处理': 'bad',
    '处理中': 'warn',
    '待复查': 'warn',
    '已驳回': 'bad',
    '已升级': 'bad',
    '低': 'ok',
    '中': 'warn',
    '高': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    surveys: { label: '巡测记录' }
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '重点保护', collection: 'sites', filter: { field: 'protectedStatus', value: '重点保护' } },
    { label: '巡测记录', collection: 'surveys' },
    { label: '待办总数', collection: 'todos', filter: { field: 'open', value: true } },
    { label: '已升级', collection: 'todos', filter: { field: 'escalated', value: true } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '趋势看板',
      type: 'dashboard',
      focusTitle: '待跟进异常（临近时限在前）',
      focus: { collection: 'todos', custom: 'openTodos', limit: 8 }
    },
    {
      id: 'todos',
      label: '复查待办',
      type: 'todos',
      listTitle: '待办列表'
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '保存样点',
      searchPlaceholder: '搜索洞穴、分区、样点、路线',
      searchFields: ['cave', 'zone', 'pointCode', 'route'],
      statusField: 'protectedStatus',
      statusOptions: ['常规观察', '重点保护', '暂停开放'],
      titleFields: ['pointCode', 'zone'],
      summaryFields: ['note'],
      detailFields: [
        { label: '洞穴', name: 'cave' },
        { label: '巡测路线', name: 'route' },
        { label: '敏感等级', name: 'sensitivity' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '保护状态', name: 'protectedStatus', type: 'select', options: ['常规观察', '重点保护', '暂停开放'] },
        { label: '基准温度(℃)', name: 'baselineTemp', type: 'number', required: true, step: 0.1 },
        { label: '基准湿度(%)', name: 'baselineHumidity', type: 'number', required: true, step: 0.1 },
        { label: '基准CO2(ppm)', name: 'baselineCo2', type: 'number', required: true },
        { label: '基准滴水(滴/分)', name: 'baselineDrip', type: 'number', required: true, step: 0.1 },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'surveys',
      label: '巡测记录',
      collection: 'surveys',
      formTitle: '登记巡测',
      listTitle: '巡测历史',
      submitLabel: '保存巡测',
      searchPlaceholder: '搜索人员、干扰痕迹、照片',
      searchFields: ['surveyor', 'disturbance', 'photoUrl'],
      statusField: 'status',
      statusOptions: ['正常', '异常待复查', '已复查'],
      titleFields: ['surveyor', 'date'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['disturbance', 'reviewNote'],
      detailFields: [
        { label: '分级', name: 'grade' },
        { label: '温度(℃)', name: 'temperature' },
        { label: '湿度(%)', name: 'humidity' },
        { label: 'CO2(ppm)', name: 'co2' },
        { label: '滴水(滴/分)', name: 'dripRate' }
      ],
      defaults: { status: '正常', reviewNote: '' },
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '巡测人员', name: 'surveyor', required: true },
        { label: '日期', name: 'date', type: 'date', required: true },
        { label: '温度(℃)', name: 'temperature', type: 'number', required: true, step: 0.1 },
        { label: '湿度(%)', name: 'humidity', type: 'number', required: true, step: 0.1 },
        { label: 'CO2(ppm)', name: 'co2', type: 'number', required: true },
        { label: '滴水频率(滴/分)', name: 'dripRate', type: 'number', required: true, step: 0.1 },
        { label: '照片链接', name: 'photoUrl' },
        { label: '游客干扰痕迹', name: 'disturbance', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'rules',
      label: '判定规则',
      type: 'rules',
      adminOnly: true
    }
  ],
  actions: [
    { id: 'site-normal', label: '常规观察', collection: 'sites', patches: [{ field: 'protectedStatus', value: '常规观察' }] },
    { id: 'site-focus', label: '重点保护', collection: 'sites', patches: [{ field: 'protectedStatus', value: '重点保护' }] },
    { id: 'site-close', label: '暂停开放', collection: 'sites', danger: true, patches: [{ field: 'protectedStatus', value: '暂停开放' }] }
  ]
};
