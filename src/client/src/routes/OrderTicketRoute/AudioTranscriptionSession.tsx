import _ from 'lodash'
import React, { PureComponent } from 'react'

import MediaRecorder, { BlobEvent, MediaRecorderInterface } from './MediaRecorder'

import * as GreenKeyRecognition from './GreenKeyRecognition'
import { Timer } from './Timer'

export interface SessionResultData extends GreenKeyRecognition.Result {}
export interface SessionResult {
  data: GreenKeyRecognition.Result
  transcripts: any
}

export interface Props {
  input: MediaStream
  onStart?: (e: any) => any
  onResult?: (e: SessionResult) => any
  onPermission?: (event: SessionEvent) => any
  onError?: (event: SessionEvent) => any
  onEnd?: (e: any) => any
}

export interface SessionEvent {
  ok: boolean
  source: Dependency
  error?: Error | ErrorEvent
}

interface State {
  recorder?: MediaRecorderInterface

  closed?: boolean
  error?: boolean

  socket?: any
  media?: any

  result?: GreenKeyRecognition.Result

  [key: string]: any
}

type Dependency = 'socket' | 'media'
type Source = 'socket' | 'media' | 'unmount'

export class AudioTranscriptionSession extends PureComponent<Props, State> {
  static getDerivedStateFromProps({ input }: Props, { recorder }: State) {
    // On UserMedia permission
    if (input && recorder == null) {
      return {
        recorder: new MediaRecorder(input),
      }
    }

    return null
  }

  state: State = {
    recorder: null,

    closed: false,
    error: false,
    socket: false,

    result: null,
  }

  recorder: MediaRecorderInterface
  socket: WebSocket & GreenKeyRecognition.WebSocketProps

  async componentDidMount() {
    this.start()
  }

  async componentDidUpdate() {
    this.start()
  }

  unmounted: boolean
  componentWillUnmount() {
    this.unmounted = true
    this.onEnd('unmount')
  }

  started: boolean
  async start() {
    const { recorder } = this.state

    if (this.started || !recorder) {
      return
    }

    this.started = true
    this.props.onStart(this)

    // Begin recording
    const event = await new Promise<BlobEvent>(next => {
      let handle: any
      recorder.addEventListener(
        'dataavailable',
        (handle = (event: any) => {
          recorder.removeEventListener('dataavailable', handle)
          next(event)
        }),
      )
      // Start recording, and trigger data event to resolve promise
      recorder.start()
      recorder.requestData()
    })

    // Send first payload
    const socket = await this.createSocket({
      contentType: event.data.type,
    })

    if (!this.unmounted) {
      socket.send(event.data)

      // Stream subsequent events
      recorder.addEventListener('dataavailable', event => {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(event.data)
        }
      })

      this.socket = socket
      this.recorder = recorder
      // Mount stream interval
      this.setState({
        socket,
        requestDataStream: true,
      })
    }
  }

  async createSocket(options?: GreenKeyRecognition.WebSocketProps) {
    return new Promise<WebSocket & GreenKeyRecognition.WebSocketProps>((resolve, reject) => {
      const socket = GreenKeyRecognition.createWebSocket({
        ...options,
        onopen: () => {
          resolve(socket)
          // this.setSource('socket', socket)
        },
        onerror: (event: ErrorEvent) => {
          reject(event)
          this.setState({ socket: false })
          this.onError('socket', event)
        },
        onmessage: (event: MessageEvent) => {
          this.onMessage(event)
        },
        onclose: async (event: CloseEvent) => {
          const { socket, media } = this.state

          if (socket && media && !this.closed && !this.state.error) {
            this.setState({ socket: false })
            this.onEnd('socket')
          }
        },
      })
    })
  }

  onMessage(event: MessageEvent) {
    if (this.state.unmount) {
      console.error('AudioTranscriptionSession.onMessage occured after unmount')

      return
    }

    const data = JSON.parse(event.data)
    this.setState({
      data,
      result: data.result,
    })

    if (this.props.onResult) {
      this.props.onResult({
        data,
        transcripts: _.map(data.segments, 'clean_transcript').map(transcript => [{ transcript }]),
      })
    }
  }

  onRequestDataInterval = () => {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.recorder.requestData()
    } else {
      console.error('Reached unexpected state in AudioTranscriptionSession')
    }
  }

  onMarkedFinalTimeout = () => {
    console.warn('Marked final')
    this.onEnd('socket')
  }

  onError(source: Dependency, error: Error | ErrorEvent) {
    this.setState({ [source]: false, error: true })
    if (this.props.onError) {
      this.props.onError({ ok: false, source, error })
    }
  }

  closed: boolean
  onEnd(source: Source) {
    this.destroy()

    if (!this.closed) {
      this.closed = true
      this.setState({ live: false, closed: true })

      if (this.props.onEnd) {
        this.props.onEnd(null)
      }
    }
  }

  destroy() {
    if (this.recorder && this.recorder.state === 'recording') {
      this.recorder.stop()
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close()
    }
  }

  render() {
    const { socket, result } = this.state
    return (
      <React.Fragment>
        {socket &&
          socket.readyState === WebSocket.OPEN && (
            <Timer duration={GreenKeyRecognition.interval} interval={this.onRequestDataInterval} />
          )}
        {result && result.final && <Timer duration={1000} timeout={this.onMarkedFinalTimeout} />}
      </React.Fragment>
    )
  }
}

export function flatten(accumulator: any, parentValue?: any, parentKey?: any): any {
  if (arguments.length === 1) {
    ;[parentValue, accumulator] = [accumulator, {}]
  }
  if (!_.isObject(parentValue) && !_.isArray(parentValue)) {
    accumulator[parentKey] = parentValue
    return accumulator
  } else {
    return _.reduce(
      parentValue,
      (a, v, k) => {
        k = _.isArray(parentValue) ? `[${k}]` : k
        return flatten(a, v, parentKey ? `${parentKey}.${k}` : k)
      },
      accumulator,
    )
  }
}