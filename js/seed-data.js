// ============================================================================
//  Voorbeeld-/testdata voor Band Admin.
//  Zie README.md voor hoe je dit liedje in Firestore laadt.
// ============================================================================

export const EXAMPLE_SONG = {
  title: "Als ze er niet is",
  artist: "De Dijk",
  capo: 0,
  content: [
    {
      type: "verse",
      lines: [
        {
          chords: [
            { chord: "Em", position: 0 },
            { chord: "A", position: 8 },
          ],
          text: "Tien tegen een dat ik mijn mond houd, als ik je weer zie",
        },
        {
          chords: [
            { chord: "Em", position: 0 },
            { chord: "A", position: 8 },
          ],
          text: "Ik ken mezelf onderhand, een prater ben ik niet",
        },
      ],
    },
  ],
  notes: [],
};

// ============================================================================
//  Voorbeeld gitaargrepen voor de 'chords' collectie in Firestore.
//  Gebruik de Firestore Console of een script om deze documenten te importeren.
//  Document-ID = akkoordnaam (bijv. "Am", "G", "C7").
//
//  frets[0..5] correspondeert met snaren (dik naar dun): E A D G B e
//    -1 = gedempt (X), 0 = open (O), 1+ = fretpositie
//  baseFret = beginpositie op de hals (1 = open positie)
//  fingers[0..5] = vingerzetting (0 = geen, 1=wijs, 2=middel, 3=ring, 4=pink)
// ============================================================================

export const EXAMPLE_CHORDS = [
  {
    id: "Am",
    chordName: "Am",
    baseFret: 1,
    frets: [-1, 0, 2, 2, 1, 0],
    fingers: [0, 0, 2, 3, 1, 0],
  },
  {
    id: "C",
    chordName: "C",
    baseFret: 1,
    frets: [-1, 3, 2, 0, 1, 0],
    fingers: [0, 3, 2, 0, 1, 0],
  },
  {
    id: "D",
    chordName: "D",
    baseFret: 1,
    frets: [-1, -1, 0, 2, 3, 2],
    fingers: [0, 0, 0, 1, 3, 2],
  },
  {
    id: "Em",
    chordName: "Em",
    baseFret: 1,
    frets: [0, 2, 2, 0, 0, 0],
    fingers: [0, 2, 3, 0, 0, 0],
  },
  {
    id: "G",
    chordName: "G",
    baseFret: 1,
    frets: [3, 2, 0, 0, 0, 3],
    fingers: [2, 1, 0, 0, 0, 3],
  },
  {
    id: "A",
    chordName: "A",
    baseFret: 1,
    frets: [-1, 0, 2, 2, 2, 0],
    fingers: [0, 0, 1, 2, 3, 0],
  },
  {
    id: "E",
    chordName: "E",
    baseFret: 1,
    frets: [0, 2, 2, 1, 0, 0],
    fingers: [0, 2, 3, 1, 0, 0],
  },
  {
    id: "F",
    chordName: "F",
    baseFret: 1,
    frets: [1, 1, 2, 3, 3, 1],
    fingers: [1, 1, 2, 3, 4, 1],
  },
  {
    id: "Dm",
    chordName: "Dm",
    baseFret: 1,
    frets: [-1, -1, 0, 2, 3, 1],
    fingers: [0, 0, 0, 2, 3, 1],
  },
  {
    id: "C7",
    chordName: "C7",
    baseFret: 1,
    frets: [-1, 3, 2, 3, 1, 0],
    fingers: [0, 3, 2, 4, 1, 0],
  },
  {
    id: "G7",
    chordName: "G7",
    baseFret: 1,
    frets: [3, 2, 0, 0, 0, 1],
    fingers: [3, 2, 0, 0, 0, 1],
  },
  {
    id: "A7",
    chordName: "A7",
    baseFret: 1,
    frets: [-1, 0, 2, 0, 2, 0],
    fingers: [0, 0, 1, 0, 2, 0],
  },
  {
    id: "E7",
    chordName: "E7",
    baseFret: 1,
    frets: [0, 2, 0, 1, 0, 0],
    fingers: [0, 2, 0, 1, 0, 0],
  },
  {
    id: "Bm",
    chordName: "Bm",
    baseFret: 2,
    frets: [-1, 2, 4, 4, 3, 2],
    fingers: [0, 1, 3, 4, 2, 1],
  },
  {
    id: "D7",
    chordName: "D7",
    baseFret: 1,
    frets: [-1, -1, 0, 2, 1, 2],
    fingers: [0, 0, 0, 2, 1, 3],
  },
];
