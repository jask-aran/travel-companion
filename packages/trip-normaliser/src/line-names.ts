/**
 * English names for the lines a Japan/Korea trip rides. NAVITIME's marketplace
 * plan answers only in Japanese, and Google names some Korean lines in Korean
 * whatever language is asked for. Unknown names pass through unchanged, so a
 * new line reads in the local script rather than vanishing.
 *
 * Longest match wins, so a specific service ("京成スカイライナー") beats the
 * operator prefix it starts with.
 */
const NAMES: [string, string][] = [
  // Airport trains
  ["京成スカイライナー", "Keisei Skyliner"],
  ["スカイライナー", "Keisei Skyliner"],
  ["成田エクスプレス", "Narita Express"],
  ["京成成田スカイアクセス線アクセス特急", "Keisei Access Express"],
  ["京成成田スカイアクセス線", "Keisei Narita Sky Access"],
  ["京成本線", "Keisei Main Line"],
  ["京成線", "Keisei Line"],
  ["都営浅草線エアポート快特", "Asakusa Line Airport Rapid"],
  ["特急ラピート", "Nankai Rapi:t"],
  ["ラピート", "Nankai Rapi:t"],
  ["南海空港線", "Nankai Airport Line"],
  ["南海本線", "Nankai Main Line"],
  ["関空快速", "JR Kansai Airport Rapid"],
  ["はるか", "Haruka"],
  ["リムジンバス", "Airport Limousine Bus"],
  // Shinkansen and limited expresses
  ["東海道新幹線", "Tokaido Shinkansen"],
  ["北陸新幹線", "Hokuriku Shinkansen"],
  ["のぞみ", "Nozomi"],
  ["ひかり", "Hikari"],
  ["こだま", "Kodama"],
  ["かがやき", "Kagayaki"],
  ["はくたか", "Hakutaka"],
  ["つるぎ", "Tsurugi"],
  ["サンダーバード", "Thunderbird"],
  ["ひだ", "Hida"],
  ["しなの", "Shinano"],
  ["近鉄特急", "Kintetsu Limited Express"],
  ["ロマンスカー", "Odakyu Romancecar"],
  // Tokyo
  ["都営大江戸線", "Toei Oedo Line"],
  ["都営新宿線", "Toei Shinjuku Line"],
  ["都営浅草線", "Toei Asakusa Line"],
  ["都営三田線", "Toei Mita Line"],
  ["東京メトロ丸ノ内線", "Marunouchi Line"],
  ["東京メトロ銀座線", "Ginza Line"],
  ["東京メトロ日比谷線", "Hibiya Line"],
  ["東京メトロ東西線", "Tozai Line"],
  ["東京メトロ千代田線", "Chiyoda Line"],
  ["東京メトロ半蔵門線", "Hanzomon Line"],
  ["東京メトロ副都心線", "Fukutoshin Line"],
  ["東京メトロ南北線", "Namboku Line"],
  ["東京メトロ有楽町線", "Yurakucho Line"],
  ["JR山手線", "JR Yamanote Line"],
  ["JR中央線快速", "JR Chuo Line (Rapid)"],
  ["JR中央線", "JR Chuo Line"],
  ["JR中央・総武線", "JR Chuo-Sobu Line"],
  ["JR総武線快速", "JR Sobu Line (Rapid)"],
  ["JR総武本線", "JR Sobu Main Line"],
  ["JR成田線", "JR Narita Line"],
  ["JR横須賀線", "JR Yokosuka Line"],
  ["JR湘南新宿ライン", "JR Shonan-Shinjuku Line"],
  ["JR埼京線", "JR Saikyo Line"],
  ["JR京浜東北線", "JR Keihin-Tohoku Line"],
  ["JR東海道本線", "JR Tokaido Line"],
  ["小田急小田原線", "Odakyu Odawara Line"],
  ["小田急線", "Odakyu Line"],
  ["箱根登山電車", "Hakone Tozan Railway"],
  ["箱根登山鉄道", "Hakone Tozan Railway"],
  ["江ノ島電鉄", "Enoden"],
  ["京王高尾線", "Keio Takao Line"],
  ["京王線", "Keio Line"],
  ["ゆりかもめ", "Yurikamome"],
  // Chubu, Kansai, Hokuriku
  ["JR高山本線", "JR Takayama Line"],
  ["JR太多線", "JR Taita Line"],
  ["JR関西本線", "JR Kansai Line"],
  ["JR北陸本線", "JR Hokuriku Line"],
  ["JR大阪環状線", "JR Osaka Loop Line"],
  ["JR京都線", "JR Kyoto Line"],
  ["JR奈良線", "JR Nara Line"],
  ["JR阪和線", "JR Hanwa Line"],
  ["名鉄犬山線", "Meitetsu Inuyama Line"],
  ["名鉄名古屋本線", "Meitetsu Nagoya Line"],
  ["名鉄", "Meitetsu"],
  ["近鉄名古屋線", "Kintetsu Nagoya Line"],
  ["近鉄鈴鹿線", "Kintetsu Suzuka Line"],
  ["伊勢鉄道", "Ise Railway"],
  ["上高地線", "Alpico Kamikochi Line"],
  ["近鉄京都線", "Kintetsu Kyoto Line"],
  ["近鉄", "Kintetsu"],
  ["名古屋市営地下鉄東山線", "Higashiyama Line"],
  ["名古屋市営地下鉄桜通線", "Sakura-dori Line"],
  ["名古屋市営地下鉄名城線", "Meijo Line"],
  ["大阪メトロ御堂筋線", "Midosuji Line"],
  ["大阪メトロ堺筋線", "Sakaisuji Line"],
  ["大阪メトロ千日前線", "Sennichimae Line"],
  ["大阪メトロ中央線", "Osaka Metro Chuo Line"],
  ["京都市営地下鉄烏丸線", "Karasuma Line"],
  ["京都市営地下鉄東西線", "Kyoto Tozai Line"],
  ["京阪本線", "Keihan Main Line"],
  ["阪急京都線", "Hankyu Kyoto Line"],
  ["南海高野線", "Nankai Koya Line"],
  ["高野山ケーブル", "Koyasan Cable Car"],
  ["新穂高ロープウェイ", "Shinhotaka Ropeway"],
  ["濃飛バス", "Nohi Bus"],
  ["北陸鉄道", "Hokutetsu"],
  ["IRいしかわ鉄道", "IR Ishikawa Railway"],
  ["ハピラインふくい", "Hapi-Line Fukui"],
  // Korea
  ["공항철도", "AREX"],
  ["서울 간선버스", "Seoul Blue Bus"],
  ["서울 지선버스", "Seoul Green Bus"],
  ["서울 광역버스", "Seoul Red Bus"],
  ["공항버스", "Airport Bus"],
  ["경의중앙선", "Gyeongui-Jungang Line"],
  ["신분당선", "Shinbundang Line"],
];

const SORTED = [...NAMES].sort((a, b) => b[0].length - a[0].length);

/** Korean places that turn up as stops and headsigns. */
const PLACES: [string, string][] = [
  ["인천공항1터미널", "Incheon Airport T1"],
  ["인천공항2터미널", "Incheon Airport T2"],
  ["김포공항", "Gimpo Airport"],
  ["서울역", "Seoul Station"],
  ["홍대입구", "Hongik Univ."],
  ["디지털미디어시티", "Digital Media City"],
  ["외선순환", "outer loop"],
  ["임진각", "Imjingak"],
  ["내선순환", "inner loop"],
];

/** Full-width letters and digits ("ＪＲ") as plain ASCII, so lookups match. */
const normalise = (name: string) => name.normalize("NFKC").trim();

export function englishLineName(raw: string): { name: string; nameLocal?: string } {
  const local = normalise(raw);
  // "N호선" is Seoul Metro line N.
  const seoul = /^(\d+)호선$/.exec(local);
  if (seoul) return { name: `Line ${seoul[1]}`, nameLocal: local };
  // NAVITIME qualifies a line with the stretch ridden: "JR高山本線(岐阜-美濃太田)".
  const bare = local.replace(/\(.*\)$/, "");
  const hit = SORTED.find(([japanese]) => bare.includes(japanese));
  if (!hit) {
    // A bus number qualified by a place: "058A(임진각)".
    const placed = PLACES.reduce((name, [korean, english]) => name.replace(`(${korean})`, ` (${english})`), local);
    if (placed !== local) return { name: placed, nameLocal: local };
    return local === raw ? { name: raw } : { name: local };
  }
  return { name: hit[1], nameLocal: local };
}

/** "서울역 방면" (bound for Seoul Station) as "Seoul Station"; else as given. */
export function englishHeadsign(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const local = normalise(raw).replace(/\s*방면$/, "").replace(/역$/, "");
  const hit = PLACES.find(([korean]) => local === korean || local === korean.replace(/역$/, ""));
  return hit ? hit[1] : normalise(raw);
}
