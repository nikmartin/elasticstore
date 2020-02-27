import { Reference } from "./types";

// Records should be added here to be indexed / made searchable
const references: Array<Reference> = [
  {
    collection: 'emails',
    type: 'emails',
    index: 'emails',
    include: ['snippet', 'from', 'id'],
    transform: (data, parent) => ({
      ...data, from: () => {
        data.payload.headers.map((h: any) => {
          if (h.name === 'From') {
            return h.value;
          }
        })
      }
    })
  }
]

export default references