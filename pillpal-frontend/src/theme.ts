import { StyleSheet } from 'react-native';

/** Brand colours (unchanged from the original design). */
export const coral = '#FF6657';
export const ink = '#23313B';
export const muted = '#687983';
export const teal = '#71CEE1';
export const paper = '#F9F8F3';
export const line = '#E7E9E8';
export const green = '#087F72';
export const red = '#C83D37';

export const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: paper },
  header: { backgroundColor: coral, paddingHorizontal: 24, paddingTop: 18, paddingBottom: 18, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  brand: { fontSize: 29, fontWeight: '800', color: '#fff' },
  subhead: { color: '#fff', marginTop: 3 },
  bell: { color: '#fff', fontSize: 22, paddingHorizontal: 6 },
  bellBadge: { position: 'absolute', top: -4, right: -2, backgroundColor: ink, color: '#fff', fontSize: 10, fontWeight: '800', borderRadius: 8, minWidth: 16, textAlign: 'center', paddingHorizontal: 3, overflow: 'hidden' },
  body: { padding: 20, paddingBottom: 40 },
  title: { fontSize: 25, fontWeight: '800', color: ink, marginBottom: 10 },
  section: { fontSize: 13, fontWeight: '800', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginTop: 18, marginBottom: 8 },
  p: { color: muted, fontSize: 15, lineHeight: 22, marginTop: 5 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 18, marginBottom: 12, borderWidth: 1, borderColor: line },
  cardFlagged: { borderColor: red },
  label: { fontSize: 17, fontWeight: '700', color: ink },
  big: { fontSize: 25, fontWeight: '800', color: ink, marginTop: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 13 },
  tile: { backgroundColor: teal, width: '48%', height: 125, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 13 },
  tileIcon: { fontSize: 42, color: '#fff', fontWeight: '700' },
  tileText: { fontWeight: '700', fontSize: 16, color: ink, marginTop: 4 },
  date: { color: muted, fontSize: 13, marginTop: 7 },
  vitalGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  metric: { width: '50%', fontSize: 19, fontWeight: '700', color: ink, marginVertical: 7 },
  unit: { fontSize: 13, color: muted },
  badge: { color: green, fontWeight: '800', fontSize: 12, marginBottom: 8 },
  alert: { color: red },
  pending: { color: muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  scheduleTime: { width: 85, color: coral, fontWeight: '800', fontSize: 17 },
  empty: { color: muted, textAlign: 'center', paddingVertical: 32 },
  back: { color: coral, fontWeight: '700', marginBottom: 15, fontSize: 16 },
  nav: { flexDirection: 'row', backgroundColor: '#fff', borderTopWidth: 1, borderColor: line, paddingVertical: 15 },
  navItem: { flex: 1, alignItems: 'center' },
  navText: { fontSize: 11, color: muted, fontWeight: '600' },
  active: { color: coral },
  login: { padding: 25, marginTop: 35 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#DEE3E4', borderRadius: 10, padding: 14, marginTop: 15, fontSize: 16, color: ink },
  inputSmall: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#DEE3E4', borderRadius: 10, padding: 10, fontSize: 15, color: ink, minWidth: 90, textAlign: 'center' },
  button: { backgroundColor: coral, borderRadius: 10, padding: 16, alignItems: 'center', marginTop: 20 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  buttonSmall: { backgroundColor: coral, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16, alignItems: 'center' },
  buttonSmallText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  buttonGhost: { borderColor: coral, borderWidth: 1, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 16, alignItems: 'center' },
  buttonGhostText: { color: coral, fontWeight: '700', fontSize: 14 },
  buttonDisabled: { opacity: 0.5 },
  chip: { borderRadius: 20, paddingVertical: 7, paddingHorizontal: 14, backgroundColor: '#EEF1F1', borderWidth: 1, borderColor: line },
  chipActive: { backgroundColor: teal, borderColor: teal },
  chipText: { color: ink, fontWeight: '600', fontSize: 14 },
  link: { color: coral, fontWeight: '700', marginTop: 20 },
  linkInline: { color: coral, fontWeight: '700' },
  error: { color: red, marginBottom: 10 },
  notice: { backgroundColor: '#FFF0CF', padding: 12, borderRadius: 8, marginBottom: 14, color: ink },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 24, fontWeight: '800', color: ink },
  statLabel: { fontSize: 12, color: muted, marginTop: 2 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderColor: line },
});
