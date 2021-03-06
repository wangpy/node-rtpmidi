"use strict";

var util = require("util"),
    EventEmitter = require("events").EventEmitter,
    dgram = require("dgram"),
    ControlMessage = require("./ControlMessage"),
    MidiMessage = require("./MidiMessage"),
    MdnsService = require("./mdns"),
    Stream = require("./Stream");


function Session(port, localName, bonjourName, ssrc) {
    EventEmitter.apply(this);
    this.streams = [];
    this.localName = localName;
	this.bonjourName = bonjourName;
    this.port = port || 5004;
	this.ssrc = ssrc;
    this.readyState = 0;
    this.published = false;

    this.debug = false;


    this.streamConnected = this.streamConnected.bind(this);
    this.streamDisconnected = this.streamDisconnected.bind(this);
    this.deliverMessage = this.deliverMessage.bind(this);
}

util.inherits(Session, EventEmitter);

Session.prototype.start = function start() {
    try {
		this.controlChannel = dgram.createSocket("udp4");
		this.controlChannel.on("message", this.handleMessage.bind(this));
		this.controlChannel.on("listening", this.listening.bind(this));
		this.messageChannel = dgram.createSocket("udp4");
		this.messageChannel.on("message", this.handleMessage.bind(this));
		this.messageChannel.on("listening", this.listening.bind(this));
        this.controlChannel.bind(this.port);
        this.messageChannel.bind(this.port + 1);
    } catch (e) {
        this.emit('error', e);
    }
};

Session.prototype.end = function(callback) {

	var i = -1,
		next = function() {
			i++;
			var stream = this.streams[i];
			if (stream) {
				stream.end(next);
			} else {
				this.unpublish();
				this.controlChannel.close();
				this.messageChannel.close();
				this.readyState = 0;
				this.published = false;
				callback && callback();
			}
		}.bind(this);

	if (this.readyState === 2) {
		next();
	} else {
		callback && callback();
	}
};

Session.prototype.now = (function () {
    if (process.hrtime) {
        var start = process.hrtime();
        return function () {
            var hrtime = process.hrtime(start);
            var now = Math.round((hrtime[0] * 10e9 + hrtime[1]) * 10e5);
            return now;
        };
    } else {
        var start = Date.now();
        return function now() {
            return (Date.now() - start) * 10;
        };
    }

})();

Session.prototype.log = function log() {
    if (this.debug) {
        console.log.apply(console, arguments);
    }
};

Session.prototype.listening = function listening() {
    this.readyState++;
    if (this.readyState == 2) {
        this.emit('ready');
    }
};

Session.prototype.handleMessage = function handleMessage(message, rinfo) {
    this.log("Incoming Message = ", message);
    var appleMidiMessage = new ControlMessage().parseBuffer(message),
        stream;
    if (appleMidiMessage.isValid) {
        stream = this.streams.filter(function (stream) {
            return stream.ssrc == appleMidiMessage.ssrc || stream.token == appleMidiMessage.token;
        }).pop();
        this.emit('controlMessage', appleMidiMessage);

        if (!stream && appleMidiMessage.command == 'invitation') {
            stream = new Stream(this);
            stream.handleControlMessage(appleMidiMessage, rinfo);
            this.addStream(stream);

        } else if (stream) {
            stream.handleControlMessage(appleMidiMessage, rinfo);
        }
    } else {
        var rtpMidiMessage = new MidiMessage().parseBuffer(message);
        stream = this.streams.filter(function (stream) {
            return stream.ssrc == rtpMidiMessage.ssrc;
        }).pop();
        if (stream) {
            stream.handleMidiMessage(rtpMidiMessage);
        }
        this.emit('midi', rtpMidiMessage);
    }
};

Session.prototype.sendMessage = function sendMessage(rinfo, message, callback) {
    message.generateBuffer();

    if (true || message instanceof MidiMessage) {
        //console.log(message);
    }

    if (message.isValid) {

        (rinfo.port % 2 == 0 ? this.controlChannel : this.messageChannel).send(message.buffer, 0, message.buffer.length, rinfo.port, rinfo.address, function () {
            this.log("Outgoing Message = ", message.buffer);
            callback && callback();
        }.bind(this));
    } else {
        console.error("Ignoring invalid message");
    }
};

Session.prototype.sendMidiMessage = function sendMidiMessage(ssrc, commands) {
    if (ssrc) {
        var stream = this.getStream(ssrc);
        if (stream) {
            stream.sendMessage({
                commands: commands
            });
            return true;
        }
        return false;
    } else {
        var streams = this.getStreams();
        for (var i = 0; i < streams.length; i++) {
            streams[i].sendMessage({
                commands: commands
            });
        }
        return true;
    }
};

Session.prototype.connect = function connect(rinfo) {
    var stream = new Stream(this);
    this.addStream(stream);
    var counter = 0;
    var connectionInterval = setInterval(function () {
        if (counter < 40 && stream.ssrc === null) {
            stream.sendInvitation(rinfo);
            counter++;
        } else {
            clearInterval(connectionInterval);
            if (!stream.ssrc) {
                console.log("Server at " + rinfo.address + ':' + rinfo.port + ' did not respond.');
            }
        }
    }, 1500);
};

Session.prototype.streamConnected = function streamConnected(event) {
    this.emit('streamAdded', {
        stream: event.stream
    });
};

Session.prototype.streamDisconnected = function streamDisconnected(event) {
    this.removeStream(event.stream);
    this.emit('streamRemoved', {
        stream: event.stream
    });
};

Session.prototype.addStream = function addStream(stream) {
    stream.on('connected', this.streamConnected);
    stream.on('disconnected', this.streamDisconnected);
    stream.on('message', this.deliverMessage);
    this.streams.push(stream);
};

Session.prototype.removeStream = function removeStream(stream) {
    stream.removeListener('connected', this.streamConnected);
    stream.removeListener('disconnected', this.streamDisconnected);
    stream.removeListener('message', this.deliverMessage);
    this.streams.splice(this.streams.indexOf(stream));
};

Session.prototype.deliverMessage = function(message) {
    this.emit('message', message);
};

Session.prototype.getStreams = function getStreams() {
    return this.streams.filter(function (item) {
        return item.isConnected;
    });
};

Session.prototype.getStream = function getStream(ssrc) {
    for (var i = 0; i < this.streams.length; i++) {
        if (this.streams[i].ssrc === ssrc) {
            return this.streams[i];
        }
    }
    return null;
};

Session.prototype.publish = function() {
    MdnsService.publish(this);
    this.published = true;
};

Session.prototype.unpublish = function() {
    MdnsService.unpublish(this);
    this.published = false;
};

Session.prototype.toJSON = function(includeStreams) {
    return {
        bonjourName: this.bonjourName,
		localName: this.localName,
		ssrc: this.ssrc,
        port: this.port,
        published: this.published,
        activated: this.readyState >=2,
        streams: includeStreams ? this.getStreams().map(function(stream) {
            return stream.toJSON();
        }) : undefined
    };
};

module.exports = Session;
