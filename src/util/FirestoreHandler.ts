import { Reference, FirebaseDocChangeType, DynamicTypeIndex } from "../types";
import { Client, IndicesPutMappingParams } from "elasticsearch";
import * as colors from 'colors'
import * as admin from 'firebase-admin'


/**
 * FirestoreCollectionHandler
 * This acts as the "state-keeper" between firestore and elasticsearch.
 * 
 * A collection's children are watched for event changes and their corresponding
 * elasticsearch records are updated. 
 * 
 * Firestore fires the onSnapshot listener for *EVERY* document on bind.
 * THIS IS EXPENSIVE.  
 */
export default class FirestoreCollectionHandler {
  private record: Reference
  private client: Client
  private ref: admin.firestore.Query
  private listeners: { [key: string]: any }
  private doesIndexExist: boolean = false

  constructor(client: Client, record: Reference) {
    this.listeners = {}
    this.record = record
    this.client = client

    this.ref = admin.firestore().collection(this.record.collection)

    // Build new root query (add where clauses, etc.)
    if (this.record.builder) {
      this.ref = this.record.builder.call(this, this.ref)
    }

    this.bind()
  }

  private bind = async () => {
    // Custom Mappings
    if (this.record.mappings) {
      const exists = await this.client.indices.exists({ index: this.record.index as string })
      if (!exists) {
        await this.client.indices.create({ index: this.record.index as string })
        await this.client.indices.putMapping({
          index: this.record.index,
          type: this.record.type,
          includeTypeName: true,
          body: {
            properties: this.record.mappings
          }
        } as IndicesPutMappingParams)
      }
    }

    if (this.record.subcollection) {
      // Building a subcollection requires getting documents first
      this.ref.onSnapshot(this.handleBindingSubcollection)
    } else {
      console.log(colors.grey(`
      Begin listening to changes for collection: ${this.record.collection}
        include: [ ${this.record.include ? this.record.include.join(', ') : ''} ]
        exclude: [ ${this.record.exclude ? this.record.exclude.join(', ') : ''} ]
      `))
      this.ref.onSnapshot(this.handleSnapshot())
    }
  }

  private handleBindingSubcollection = async (snap: admin.firestore.QuerySnapshot) => {

    snap.docChanges().forEach(change => {
      const changeType: FirebaseDocChangeType = change.type
      if (changeType === 'added') {
        let subref = admin.firestore().collection(`${this.record.collection}/${change.doc.id}/${this.record.subcollection}`)

        // Build a subquery for each subcollection reference
        if (this.record.subBuilder) {
          subref = this.record.subBuilder.call(this, subref)
        }

        console.log(colors.grey(`
        Begin listening to changes for collection: ${this.record.collection}
          documentId: ${change.doc.id}
          subcollection: ${this.record.subcollection}
          include: [ ${this.record.include ? this.record.include.join(', ') : ''} ]
          exclude: [ ${this.record.exclude ? this.record.exclude.join(', ') : ''} ]
        `))

        // Keep track of listeners as the parent document could be removed and leave us with a dangling listener
        this.listeners[change.doc.id] = subref.onSnapshot(this.handleSnapshot(change.doc))
      } else if (changeType === 'removed') {
        if (this.listeners[change.doc.id]) {
          this.listeners[change.doc.id].call()
        }
      }
    });
  }

  private handleSnapshot = (parentSnap?: admin.firestore.DocumentSnapshot) => {
    return (snap: admin.firestore.QuerySnapshot) => {

      snap.docChanges().forEach(change => {
        const changeType: FirebaseDocChangeType = change.type

        const index = typeof this.record.index === 'function' ? this.record.index.call(this, snap, parentSnap) : this.record.index
        const type = typeof this.record.type === 'function' ? this.record.type.call(this, snap, parentSnap) : this.record.type

        switch (changeType) {
          case "added":
            this.handleAdded(change.doc, parentSnap, index, type)
            break;
          case "modified":
            this.handleModified(change.doc, parentSnap, index, type)
            break;
          case "removed":
            this.handleRemoved(change.doc, index, type)
            break;
        }
      });
    }
  }

  private handleAdded = async (doc: admin.firestore.DocumentSnapshot, parentSnap: admin.firestore.DocumentSnapshot, index: string, type: string) => {
    let body: any = this.filter(doc.data())

    // Filtering has excluded this record
    if (!body) return

    if (this.record.transform) {
      body = this.record.transform.call(this, body, parentSnap)
    }

    try {
      const exists = await this.client.exists({ id: doc.id, index, type })
      if (exists) {
        // retryOnConflict added in reference to https://github.com/acupajoe/elasticstore/issues/2
        await this.client.update({ id: doc.id, index, type, body: { doc: body, doc_as_upsert: true }, retryOnConflict: 2 })
      } else {
        await this.client.index({ id: doc.id, index, type, body: body })
      }
    } catch (e) {
      console.error(`Error in \`FS_ADDED\` handler [doc@${doc.id}]: ${e.message}`)
    }
  }

  private handleModified = async (doc: admin.firestore.DocumentSnapshot, parentSnap: admin.firestore.DocumentSnapshot, index: string, type: string) => {
    let body = this.filter(doc.data())

    // Filtering has excluded this record
    if (!body) return

    if (this.record.transform) {
      body = this.record.transform.call(this, body, parentSnap)
    }

    try {
      // retryOnConflict added in reference to https://github.com/acupajoe/elasticstore/issues/2
      await this.client.update({ id: doc.id, index, type, body: { doc: body }, retryOnConflict: 2 })
    } catch (e) {
      console.error(`Error in \`FS_MODIFIED\` handler [doc@${doc.id}]: ${e.message}`)
    }
  }

  private handleRemoved = async (doc: admin.firestore.DocumentSnapshot, index: string, type: string) => {
    try {
      await this.client.delete({ id: doc.id, index, type })
    } catch (e) {
      console.error(`Error in \`FS_REMOVE\` handler [doc@${doc.id}]: ${e.message}`)
    }
  }

  private filter = (data: any) => {
    let shouldInsert = true
    if (this.record.filter) {
      shouldInsert = this.record.filter.call(this, data)
    }

    if (!shouldInsert) {
      return null
    }

    if (this.record.include) {
      for (const key of Object.keys(data)) {
        if (this.record.include.indexOf(key) === -1) {
          delete data[key]
        }
      }
    }

    if (this.record.exclude) {
      for (const key of this.record.exclude) {
        if (data[key]) {
          delete data[key]
        }
      }
    }

    return data
  }
}
