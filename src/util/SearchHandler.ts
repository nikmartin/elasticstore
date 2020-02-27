import Config from '../config'
import * as admin from 'firebase-admin'
import * as colors from 'colors'
import { Client } from 'elasticsearch'
import { CollectionReference, QuerySnapshot, QueryDocumentSnapshot, DocumentReference } from '@google-cloud/firestore'
import { FirebaseDocChangeType } from '../types';

export class SearchHandler {
  private client: Client
  private cleanupInterval: number
  private queryRef: CollectionReference
  private reqKey: string
  private resKey: string
  private unsubscribe: any

  constructor(client: Client) {
    this.client = client
    this.cleanupInterval = Config.CLEANUP_INTERVAL
    this.queryRef = admin.firestore().collection(Config.FB_ES_COLLECTION)
    this.reqKey = Config.FB_REQ
    this.resKey = Config.FB_RES

    console.log(colors.grey(`Listening on: '${Config.FB_ES_COLLECTION}' for queries (in: ${this.reqKey} -> out: ${this.resKey})`))

    this.unsubscribe = this.queryRef.where(this.resKey, '==', null).onSnapshot(this.handleSnapshot)

    console.log(colors.grey(`Cleanup will happen in ${this.cleanupInterval}`))
    this.unsubscribe = setTimeout(this.cleanup, this.cleanupInterval)
  }

  private handleSnapshot = (snap: QuerySnapshot) => {
    snap.docChanges().forEach(change => {
      const type = change.type as FirebaseDocChangeType
      if (type === "added") {
        this.process(change.doc)
      }
    });
  }

  private process = (snap: QueryDocumentSnapshot) => {

    console.log(colors.grey(`processing query request: ${snap.id}`));

    let request = snap.data()[this.reqKey]

    if (typeof request !== 'object') {
      try {
        request = JSON.parse(request)
      } catch{
        //ignore 
      }
    }

    if (!request.index || !request.type || (!request.q && !request.body)) {
      return this.respondError(snap.ref, 'Queries are required to have an `index`, `type` and either a `q`:string or `body`')
    }

    this.client.search(request, (error, response) => {
      if (error)
        this.respondError(snap.ref, error)
      else
        this.respond(snap.ref, response)
    })
  }

  private respond = async (ref: DocumentReference, response: any) => {
    if (response.error) {
      this.respondError(ref, response.error)
    } else {
      // coeerce into a map instead of an array
      if (response.hits && response.hits.hits) {
        const temp: any = {}
        for (const hit of response.hits.hits) {
          temp[hit._id] = hit
        }
        response.hits.hits = temp
      }
      this.send(ref, response)
    }
  }

  private respondError = async (ref: DocumentReference, message: string) => {
    let data: { [key: string]: any } = {}

    data[this.resKey] = {
      total: 0,
      error: message.toString(),
    }
    await ref.update(data)
  }

  private send = async (ref: DocumentReference, response: any) => {
    let data: { [key: string]: any } = {}
    data[this.resKey] = response
    data[this.resKey].timestamp = new Date()
    await ref.update(data)
  }

  private cleanup = async () => {
    console.log(colors.grey(`${new Date()}: Running Cleanup`))
    const items = await this.queryRef.orderBy(`${this.resKey}.timestamp`).endAt(new Date(Date.now() - this.cleanupInterval)).get()
    var count = items.docs.length
    if (count) {
      console.warn(colors.red(`housekeeping: found ${count} outbound orphans (removing them now) ${new Date()}`))
      for (const item of items.docs) {
        await item.ref.delete()
      }
    }

    // Let's go again
    clearTimeout(this.unsubscribe)
    this.unsubscribe = setTimeout(this.cleanup, this.cleanupInterval)
  }
}