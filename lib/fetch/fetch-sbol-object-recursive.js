
var SBOLDocument = require('sboljs')

var sparql = require('../sparql/sparql')

var config = require('../config')

var resolveBatch = config.get('resolveBatch')

var webOfRegistries = config.get('webOfRegistries')

var databasePrefix = config.get('databasePrefix')

var request = require('request')

var async = require('async')

var assert =  require('assert')

/* Retrieves an SBOL object *recursively*, in that anything it references, and
 * anything those objects reference (and so on) are resolved.  This is hugely
 * expensive (> 10 minutes) for large Collections, which is why the Collection
 * page currently uses metadata instead of an sboljs object.
 *
 * TODO: the collection page can use SBOL, it just needs to use the not yet
 * implemented "fetch SBOL object and children".  There's also no reason that
 * for example a ComponentDefinition couldn't have millions of components
 * (human genome?), so we should probably make sure that none of the pages for
 * top levels rely on recursively resolved SBOL documents and make them use
 * the "object and children" fetcher instead.
 *
 * TODO: make the recursive crawl fail for things that are obviously too big
 * to resolve everything.
 */
function fetchSBOLObjectRecursive(sbol, type, uri, graphUri) {

    const args = [].slice.call(arguments, 0)

    /* fetchSBOLObjectRecursive(uri, graphUri)
     */
    if(args.length === 2) {

        sbol = new SBOLDocument()
        type = null
        uri = args[0]
        graphUri = args[1]

    } else if(args.length === 3) {

        /* fetchSBOLObjectRecursive(type, uri, graphUri)
        */
        sbol = new SBOLDocument()
        type = args[0]
        uri = args[1]
        graphUri = args[2]
    }

    if(Array.isArray(uri)) {
        assert(uri.length === 1)
        uri = uri[0]
    }

    sbol._resolving = {};
    sbol._rootUri = uri

    sbol.lookupURI(sbol._rootUri)

    return sparql.queryJson([
        'SELECT ?rootCollection WHERE {',
        '?rootCollection a <http://sbols.org/v2#Collection> .',
        '?rootCollection <http://wiki.synbiohub.org/wiki/Terms/synbiohub#rootCollection> ?rootCollection .',
        'FILTER(?rootCollection = <' + sbol._rootUri + '>)',
        '}'
    ].join('\n'), graphUri).then((results) => {

        /* if(results.length > 0) {

            return getRootCollectionSBOL(sbol, type, graphUri)

        } else { */

            return getSBOLRecursive(sbol, type, graphUri)

        //}

    })

}

function getRootCollectionSBOL(sbol, type, graphUri) {

    return sparql.queryJson([
        'SELECT (COUNT(*) as ?count) WHERE {',
        '?s <http://wiki.synbiohub.org/wiki/Terms/synbiohub#rootCollection> <' + sbol._rootUri + '> .',
        '?s ?p ?o .',
        '}'
    ].join('\n'), graphUri).then((results) => {

        var countLeft = results[0].count
        var offset = 0
        var limit = config.get('staggeredQueryLimit')

        var rdf = []

        return doNextQuery()

        function doNextQuery() {

            console.log(countLeft + ' left of ' + results[0].count)

            if(countLeft > 0) {

                return sparql.query([
                    'SELECT ?s ?p ?o WHERE {',
                    '?s <http://wiki.synbiohub.org/wiki/Terms/synbiohub#rootCollection> <' + sbol._rootUri + '> .',
                    '?s ?p ?o .',
                    '} OFFSET ' + offset + ' LIMIT ' + limit
                ].join('\n'), graphUri, 'application/n-triples').then((res) => {

                    console.log(res)

                    rdf.push(res.body)

                    countLeft -= limit

                    return doNextQuery()

                })

            } else {

                return saveN3ToRdfXml(rdf).then(() => {
                    return new Promise((resolve, reject) => {

                        console.log('loading rdf')

                        sbol.loadRDF(rdf, (err) => {

                            console.log('rdf loaded')

                            if(err) {
                                reject(err)
                                return
                            }
 
                            const object = sbol.lookupURI(sbol._rootUri)

                            sbol.graphUri = graphUri
                            object.graphUri = graphUri

                            resolve({
                                graphUri: graphUri,
                                sbol: sbol,
                                object: object 
                            })
                        })

                    })
                })

            }

        }
    })

}

function getSBOLRecursive(sbol, type, graphUri) {

    var complete = false;
    var resolved = false;

    return new Promise((resolve, reject) => {

        async.series([

            function getLocalParts(next) {

                completePartialDocument(graphUri, sbol, type, (err) => {

                    if(err) {
                        next(err)

                    } else {

                        if(!complete) {

                            complete = true

                            next()
                        }

                    }
                })
            },

            function fetchNonLocalSBOL(next) {
                async.each(sbol.unresolvedURIs, (uri, nextUri) => {
		    // TODO: temporary until URIs fixed
		    if (uri.toString().startsWith('http://wiki.synbiohub.org/')) {
			nextUri()
		    } else {
			prefix = uri.toString().replace('http://','')
			prefix = prefix.substring(0,prefix.indexOf('/'))
			if (webOfRegistries[prefix]) {
			    uri = uri.replace(prefix,webOfRegistries[prefix]) + '/sbol'
			    request({
				method: 'GET',		
				uri: uri,
				'content-type': 'application/rdf+xml',
			    }, function(err, response, body) {	
				if(err || response.statusCode >= 300) {		
				    nextUri()
				} else {
				    sbol.loadRDF(body, nextUri)
				}
			    })
			} else {
			    nextUri()
			}
		    }
                }, next)
            }

        ], function done(err) {

            if (err) {

                reject(err)

            } else {

                resolve({
                    sbol: sbol,
                    object: sbol.lookupURI(sbol._rootUri)
                })
            }
        })

    })

}

function completePartialDocument(graphUri, sbol, type, next) {

    console.log(sbol.unresolvedURIs.length + ' unresolved URI(s)')

    if(sbol.unresolvedURIs.length === 0) {

        next();

    } else {
 
        var toResolve = sbol.unresolvedURIs.filter((uri) => !sbol._resolving[uri] && 
						   uri.toString().startsWith(databasePrefix))
                                .map((uri) => uri.toString())

        toResolve = toResolve.slice(0, resolveBatch)

        retrieveSBOL(graphUri, sbol, type, toResolve, (err) => {

            if(err) {
                next(err)
                return
            }

            var done = true

            // somehow we killed the optimiser by doing uri toString inside
            // the loop, so let's do it first...
            //
            // ~50 seconds -> instant, thanks v8
            //
            var uriStrings = sbol.unresolvedURIs.map((uri) => uri.toString())

            for(var i = 0; i < uriStrings.length; ++ i)
            {
                var uri = uriStrings[i]

                var uriString = uri

                if (toResolve.indexOf(uriString) === -1 && uriString.startsWith(databasePrefix))
                {
                    done = false
                }
            }

            if (done) {
                next()
                return
            }

            completePartialDocument(graphUri, sbol, type, next)

        })
    }
}

function retrieveSBOL(graphUri, sbol, type, uris, next) {

    Object.assign(sbol._resolving, uris)

    var countQuery = sparqlDescribeSubjects(sbol, type, uris, true)

    var query = sparqlDescribeSubjects(sbol, type, uris, false)

    var offset = 0
    var limit = config.get('staggeredQueryLimit')
    var countLeft

    sparql.queryJson(countQuery, graphUri).then((res) => {

        console.log('count is ' + res[0].count)

        countLeft = res[0].count

        // if(countLeft === 0) {

        //     console.log(countQuery)

        //     next(new Error('incomplete document?'))
        //     return

        // }

        var rdf = []

        return doQuery()

        function doQuery() {

            return sparql.query(query + ' OFFSET ' + offset + ' LIMIT ' + limit, graphUri, 'application/rdf+xml').then((res) => {

                countLeft -= limit
                offset += limit

                rdf.push(res.body)

                if(countLeft > 0) {

                    return doQuery()

                } else {

                    console.log('loading rdf')

                    sbol.loadRDF(rdf, next)

                }

            }).catch((err) => {

                next(err)

            })
        }

    })

    
}

function sparqlDescribeSubjects(sbol, type, uris, isCount) {

    /*
    var triples = uris.map((uri, n) =>
        sparql.escapeIRI(uri) + ' ?p' + n + ' ?o' + n + ' .'
    )

    return [
        'CONSTRUCT {'
    ].concat(triples).concat([
        '} WHERE {'
    ]).concat(triples).concat([
        '}'
    ]).join('\n')*/

   var query = [
       isCount ?
           'SELECT (count(?s) as ?count) WHERE {'
       :
           'CONSTRUCT { ?s ?p ?o } WHERE {'
   ]

   var isFirst = true

   uris.forEach((uri) => {

       if(isFirst)
           isFirst = false
       else
           query.push('UNION')

       query.push(
           '{',
           '?s ?p ?o .'
        )

       if(uri === sbol._rootUri) {
           if(type !== null) {
               if (type === "TopLevel") {
                   query.push('?s a ?t .')
                   // TODO: the generic top level will not work
                   query.push('FILTER(?t = <http://sbols.org/v2#ComponentDefinition>' + ' ||' + 
                       ' ?t = <http://sbols.org/v2#ModuleDefinition>' + ' ||' + 
                       ' ?t = <http://sbols.org/v2#Model>' + ' ||' + 
                       ' ?t = <http://sbols.org/v2#Collection>' + ' ||' + 
                       ' ?t = <http://sbols.org/v2#Sequence>' + ' ||' + 
                       ' ?t = <http://sbols.org/v2#GenericTopLevel>)')
               } else if (type != 'GenericTopLevel') {
                   query.push('?s a <http://sbols.org/v2#' + type + '> .')
               }
           }
       }

        query.push(
           'FILTER(?s = ' + sparql.escapeIRI(uri) + ')',
           '}'
        )
   })

   query.push('}')

   return query.join('\n')
}

module.exports = {
    fetchSBOLObjectRecursive
}


